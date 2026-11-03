import type { SdkWorkerInit, SdkWorkerSession, SdkWorkerEvent as AdapterEvent } from "../../internal/sdk-worker-api.js";
import type { LaneSendInput, ProbeResult } from "../../internal/adapter.js";

export async function qoderWorker(init: SdkWorkerInit, emit: (event: AdapterEvent) => void): Promise<SdkWorkerSession | ProbeResult> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const sdk = await load(init.moduleUrl);
  if (typeof sdk.query !== "function" || typeof sdk.qodercliAuth !== "function" || typeof sdk.shutdownDaemon !== "function" || typeof sdk.startDaemon !== "function") {
    throw Object.assign(new Error("Qoder SDK lacks its persistent daemon contract"), { code: "incompatible_configuration" });
  }
  const { randomUUID } = await load("node:crypto");
  const sessionId = init.sessionId ?? randomUUID();
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream = async function* () {
    while (!closed) {
      const item = queue.shift();
      if (item) { yield item; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  };
  const token = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  const service = process.env.QODER_SERVICE_ACCOUNT_KEY;
  if (service && token) throw Object.assign(new Error("Qoder credentials select two authentication methods"), { code: "incompatible_configuration" });
  const auth = service ? sdk.serviceAccount(service) : token ? sdk.accessToken(token) : sdk.qodercliAuth();
  const options: any = {
    cwd: init.cwd, env: { ...process.env, QODER_EXPOSE_TOKEN_USAGE: "1" }, auth,
    permissionMode: "bypassPermissions", includePartialMessages: true,
    ...(init.instructions ? { systemPrompt: { type: "preset", preset: "qodercli", append: init.instructions } } : {}),
    ...(init.sessionId ? { resume: init.sessionId } : { sessionId }),
    ...(init.config.model ? { model: init.config.model } : {}),
    ...(init.config.reasoningEffort ? { extraArgs: { "reasoning-effort": init.config.reasoningEffort } } : {}),
    ...(init.config.command ? { pathToQoderCLIExecutable: init.config.command, transport: sdk.ProcessTransport.default } : {}),
  };
  if (init.probe) {
    const daemon = await sdk.startDaemon({ auth, env: options.env, ...(init.config.command ? { pathToQoderCLIExecutable: init.config.command, launchMode: "process" } : {}) });
    try {
      if (!init.probe.includeModels) return { status: "healthy" };
      const models = await daemon.getModels();
      const nativeDefault = models.find((model: any) => model.isDefault === true && typeof model.value === "string");
      return { status: "healthy", reasoning: { updateMode: "unsupported", ...(nativeDefault ? { defaultModelId: nativeDefault.value } : {}), models: models.filter((model: any) => typeof model.value === "string").slice(0, 1024).map((model: any) => ({
        id: model.value, displayName: model.displayName,
        supportedReasoningEfforts: (model.efforts ?? []).map((value: string) => ({ value })),
        ...(typeof model.defaultEffort === "string" ? { defaultReasoningEffort: model.defaultEffort } : {}),
      })) } };
    } finally { await daemon.stop(); }
  }
  const query = sdk.query({ prompt: stream(), options });
  let resolveInit!: () => void;
  let rejectInit!: (error: unknown) => void;
  const nativeInit = new Promise<void>((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
  void nativeInit.catch(() => {});
  let active: { owner: string; root: string; pending: Set<string>; inputs: Map<string, { started: boolean; references: NonNullable<LaneSendInput["inputs"]> }>; result?: any } | undefined;
  let streamed = false;
  let ready = false;
  const tools = new Map<string, string>();
  const metric = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const finish = () => {
    if (!active?.result || active.pending.size) return;
    const root = active;
    active = undefined;
    const result = root.result;
    if (result.is_error) emit({ kind: "error", code: "qoder_turn_failed", message: result.errors?.join("\n") || result.error_message || "Qoder execution failed" });
    const usage = result.usage;
    if (usage) {
      const read = metric(usage.cache_read_input_tokens);
      const write = metric(usage.cache_creation_input_tokens);
      emit({ kind: "telemetry", name: "token_usage", source: "qoder_result", usage: {
        input: metric(usage.input_tokens), output: metric(usage.output_tokens), cache: read !== null && write !== null ? read + write : null,
      } });
    }
    for (const [callId, name] of tools) emit({ kind: "tool_output", callId, name });
    tools.clear();
    emit({ kind: "turn_end", sessionId, turnOwner: root.owner,
      outcome: /^aborted_/.test(result.terminal_reason ?? "") ? "interrupted" : result.is_error ? "failed" : "success" });
  };
  const consuming = (async () => {
    for await (const frame of query) {
      if (closed) return;
      if (frame.parent_tool_use_id) {
        emit({ kind: "internal_progress", source: "qoder", itemType: frame.type, attribution: { scope: "child", parentCallId: frame.parent_tool_use_id } });
        continue;
      }
      if (frame.session_id && frame.session_id !== sessionId) throw new Error("Qoder reported another session identity");
      if (frame.type === "system" && frame.subtype === "init") {
        if (typeof frame.model === "string") emit({ kind: "configuration_observed", observation: { evidence: "observed", effective: "current", model: frame.model } });
        resolveInit(); continue;
      }
      if (!active) continue;
      if (frame.type === "command_lifecycle") {
        const input = active.inputs.get(frame.command_uuid);
        if (!input) continue;
        if (frame.state === "started") {
          input.started = true;
          active.result = undefined;
          emit({ kind: "input_observed", inputs: input.references, evidence: "native_ack" });
        } else if (frame.state === "completed" || frame.state === "cancelled" || frame.state === "discarded") {
          active.pending.delete(frame.command_uuid);
          if (frame.state !== "completed") {
            emit({ kind: "input_returned", inputs: input.references, evidence: input.started ? "unknown" : "explicitly_rejected", reason: "Qoder cancelled or discarded an owned input", retryable: !input.started });
            if (!input.started && !active.pending.size && !active.result) active.result = { terminal_reason: "aborted_queued", is_error: false };
          }
          finish();
        }
      } else if (frame.type === "stream_event") {
        const event = frame.event;
        if (event?.type === "message_start") streamed = false;
        if (event?.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") { streamed = true; emit({ kind: "assistant_message_delta", text: event.delta.text }); }
          else if (event.delta?.type === "thinking_delta") emit({ kind: "assistant_reasoning_delta", text: event.delta.thinking });
        }
      } else if (frame.type === "assistant") {
        for (const block of frame.message?.content ?? []) {
          if (block.type === "text" && !streamed) emit({ kind: "assistant_message_completed", text: block.text });
          else if (block.type === "tool_use" && typeof block.id === "string" && !tools.has(block.id)) {
            tools.set(block.id, block.name);
            emit({ kind: "tool_call", callId: block.id, name: block.name, input: block.input });
          }
        }
      } else if (frame.type === "user") {
        for (const block of frame.message?.content ?? []) {
          if (block.type !== "tool_result" || !tools.has(block.tool_use_id)) continue;
          emit({ kind: "tool_output", callId: block.tool_use_id, name: tools.get(block.tool_use_id)!, outcome: block.is_error ? "failed" : "success", output: block.content });
          tools.delete(block.tool_use_id);
        }
      } else if (frame.type === "result") {
        active.result = frame;
        finish();
      } else if (frame.type === "system" && frame.subtype === "status" && frame.status === "compacting") emit({ kind: "compaction_started" });
    }
    if (!closed) throw new Error("Qoder SDK ended its persistent stream");
  })();
  void consuming.catch((error: unknown) => {
    rejectInit(error);
    if (!closed && ready) emit({ kind: "worker_error", code: "qoder_stream_failed", message: error instanceof Error ? error.message : "Qoder stream failed" });
  });
  const close = async () => {
    closed = true; wake?.();
    try { await query.close(); } finally { await sdk.shutdownDaemon(); }
  };
  try {
    await query.initializationResult();
    await nativeInit;
    ready = true;
  } catch (error) {
    await close();
    if (init.sessionId && /(?:session|conversation|history).*(?:not found|missing|unknown)|(?:not found|missing|unknown).*(?:session|conversation|history)/i.test(String(error))) {
      throw Object.assign(new Error("Qoder session history is missing"), { code: "reset_required" });
    }
    throw error;
  }
  return {
    sessionId,
    acquisition: { status: init.sessionId ? "resumed" : "created", evidence: "native_api" },
    async send(input: LaneSendInput) {
      if (closed) return { ok: false, reason: "closed" };
      if (input.mode === "idle" && active) return { ok: false, reason: "runtime_busy" };
      if (input.mode === "busy" && !active) return { ok: false, reason: "runtime_busy" };
      const uuid = randomUUID();
      const owner = input.terminalOwner ?? active?.owner ?? uuid;
      if (!active) {
        active = { owner, root: uuid, pending: new Set(), inputs: new Map() };
        streamed = false;
      }
      active.pending.add(uuid);
      active.inputs.set(uuid, { started: false, references: input.inputs ?? [] });
      queue.push({ type: "user", uuid, session_id: sessionId, priority: "next", parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: input.text }] } });
      wake?.(); wake = undefined;
      return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt", receipt: owner };
    },
    async interrupt() { if (!active) return false; await query.interrupt(); return true; },
    close,
  };
}
