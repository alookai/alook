import type { SdkWorkerInit, SdkWorkerSession, SdkWorkerEvent } from "../../internal/sdk-worker-api.js";
import type { LaneSendInput, ProbeResult } from "../../internal/adapter.js";

export async function copilotWorker(init: SdkWorkerInit, emit: (event: SdkWorkerEvent) => void): Promise<SdkWorkerSession | ProbeResult> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const sdk = await load(init.moduleUrl);
  if (typeof sdk.CopilotClient !== "function" || typeof sdk.RuntimeConnection?.forStdio !== "function") {
    throw Object.assign(new Error("Copilot SDK lacks its owned stdio connection contract"), { code: "incompatible_configuration" });
  }
  const client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio({ ...(init.config.command ? { path: init.config.command } : {}) }),
    workingDirectory: init.cwd,
  });
  let session: any;
  let closed = false;
  type Root = { owner: string; inFlight: number; pending: Set<string>; observed: Set<string>; idle: boolean; failed: boolean; aborted: boolean };
  let active: Root | undefined;
  const tools = new Map<string, string>();
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (active && session) await session.abort(); }
    finally { try { await session?.disconnect(); } finally { await client.stop(); } }
  };
  try {
    await client.start();
    if (init.probe) {
      if (!init.probe.includeModels) { await close(); return { status: "healthy" }; }
      const models = await client.listModels();
      await close();
      return { status: "healthy", reasoning: { updateMode: "unsupported", models: models.filter((model: any) => typeof model.id === "string").slice(0, 1024).map((model: any) => ({
        id: model.id, displayName: model.name,
        supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((value: string) => ({ value })),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      })) } };
    }
    const config = {
      workingDirectory: init.cwd, streaming: true, onPermissionRequest: sdk.approveAll,
      ...(init.instructions ? { systemMessage: { mode: "append", content: init.instructions } } : {}),
      ...(init.config.model ? { model: init.config.model } : {}),
      ...(init.config.reasoningEffort ? { reasoningEffort: init.config.reasoningEffort } : {}),
    };
    session = init.sessionId
      ? await client.resumeSession(init.sessionId, { ...config, allowTranscriptRecovery: false, continuePendingWork: true })
      : await client.createSession({ ...config, trustWorkingDirectory: "session" });
    if (typeof session.sessionId !== "string" || (init.sessionId && session.sessionId !== init.sessionId)) {
      throw Object.assign(new Error("Copilot did not restore the requested session"), { code: "reset_required" });
    }
    if (typeof session.send !== "function" || typeof session.on !== "function") throw new Error("Copilot SDK lacks persistent input observations");
  } catch (error) {
    await close();
    if (init.sessionId && /(?:session|conversation|history).*(?:not found|missing|unknown)|(?:not found|missing|unknown).*(?:session|conversation|history)/i.test(String(error))) {
      throw Object.assign(new Error("Copilot session history is missing"), { code: "reset_required" });
    }
    throw error;
  }
  const finish = (root: Root) => {
    if (closed || active !== root || root.inFlight || !root.idle || (!root.failed && (root.pending.size || !root.observed.size))) return;
    active = undefined;
    for (const [callId, name] of tools) emit({ kind: "tool_output", callId, name });
    tools.clear();
    emit({ kind: "turn_end", sessionId: session.sessionId, turnOwner: root.owner, ...(root.aborted ? { outcome: "interrupted" as const } : {}) });
  };
  session.on((event: any) => {
    const root = active;
    if (closed || !root || event.agentId || event.data?.agentId || event.data?.parentToolCallId) return;
    const data = event.data ?? {};
    if (event.type === "user.message" && typeof data.messageId === "string") {
      root.observed.add(data.messageId);
      root.pending.delete(data.messageId);
    } else if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") emit({ kind: "assistant_message_delta", text: data.deltaContent });
    else if (event.type === "assistant.reasoning_delta" && typeof data.deltaContent === "string") emit({ kind: "assistant_reasoning_delta", text: data.deltaContent });
    else if (event.type === "tool.execution_start" && typeof data.toolCallId === "string") {
      const name = data.toolName ?? "unknown_tool";
      tools.set(data.toolCallId, name);
      emit({ kind: "tool_call", callId: data.toolCallId, name, input: data.arguments ?? {} });
    } else if (event.type === "tool.execution_complete" && tools.has(data.toolCallId)) {
      emit({ kind: "tool_output", callId: data.toolCallId, name: tools.get(data.toolCallId)! });
      tools.delete(data.toolCallId);
    } else if (event.type === "session.warning" && data.warningType === "policy_blocked" && typeof data.originatingMessageId === "string") {
      root.observed.add(data.originatingMessageId);
      root.pending.delete(data.originatingMessageId);
      root.failed = true;
      emit({ kind: "error", code: "copilot_policy_blocked", message: data.message ?? "Copilot policy blocked an input" });
    } else if (event.type === "session.error" && data.eligibleForAutoSwitch === true) {
      emit({ kind: "runtime_diagnostic", severity: "warning", source: "copilot", message: data.message ?? "Copilot is switching models after a rate limit" });
    } else if (event.type === "session.error") {
      root.failed = true;
      emit({ kind: "error", code: "copilot_run_failed", message: data.message ?? "Copilot reported an execution error" });
    } else if (event.type === "assistant.turn_start" && typeof data.turnId === "string") emit({ kind: "turn_owner", receipt: root.owner, nativeTurnId: data.turnId });
    else if (event.type === "session.idle" && data.mode !== "autopilot") {
      root.idle = true;
      root.aborted ||= data.aborted === true;
    } else if (event.type === "assistant.usage") {
      const metric = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
      emit({ kind: "telemetry", name: "token_usage", source: "copilot_assistant_usage", usage: {
        input: metric(data.inputTokens), output: metric(data.outputTokens), cache: metric(data.cacheReadTokens) !== null && metric(data.cacheWriteTokens) !== null ? data.cacheReadTokens + data.cacheWriteTokens : null,
      } });
    }
    finish(root);
  });
  return {
    sessionId: session.sessionId,
    async send(input: LaneSendInput) {
      if (closed) return { ok: false, reason: "closed" };
      if ((input.mode === "idle" && active) || (input.mode === "busy" && !active)) return { ok: false, reason: "runtime_busy" };
      const root: Root = active ?? { owner: input.terminalOwner!, inFlight: 0, pending: new Set(), observed: new Set(), idle: false, failed: false, aborted: false };
      if (!root.owner) return { ok: false, reason: "missing_terminal_owner" };
      active = root;
      root.inFlight++;
      root.idle = false;
      try {
        const id = await session.send({ prompt: input.text, mode: input.mode === "busy" ? "immediate" : "enqueue" });
        if (typeof id !== "string" || !id) throw new Error("Copilot did not return a native input identity");
        if (!root.observed.has(id)) root.pending.add(id);
        return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt", receipt: root.owner };
      } catch (error) {
        if (input.mode === "idle" && active === root) active = undefined;
        throw error;
      } finally { root.inFlight--; finish(root); }
    },
    async interrupt() { if (!active) return false; active.aborted = true; await session.abort(); return true; },
    close,
  };
}
