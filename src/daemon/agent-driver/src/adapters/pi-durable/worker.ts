import type { SdkWorkerInit, SdkWorkerSession, SdkWorkerEvent as AdapterEvent } from "../../internal/sdk-worker-api.js";
import type { LaneSendInput, ProbeResult } from "../../internal/adapter.js";

export async function piDurableWorker(init: SdkWorkerInit, emit: (event: AdapterEvent) => void): Promise<SdkWorkerSession | ProbeResult> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const sdk = await load(init.moduleUrl);
  if (typeof sdk.Harness?.open !== "function" || typeof sdk.createRegistry !== "function") throw Object.assign(new Error("Pi Durable lacks its Harness contract"), { code: "incompatible_configuration" });
  const resolver = await load("data:text/javascript,export const resolve = (s,p) => import.meta.resolve(s,p)");
  const peer = (name: string) => load(resolver.resolve(name, init.moduleUrl));
  const { DatabaseSync } = await load("node:sqlite");
  const { getSupportedThinkingLevels } = await peer("@earendil-works/pi-ai/models");
  const { builtinModels } = await peer("@earendil-works/pi-ai/providers/all");
  const { InMemoryCredentialStore } = await peer("@earendil-works/pi-ai");
  const credential = init.config.provider;
  const credentials = new InMemoryCredentialStore();
  if (credential?.kind === "builtin" && credential.providerId && credential.apiKey) {
    await credentials.modify(credential.providerId, async () => ({ type: "api_key", key: credential.apiKey }));
  }
  const models = builtinModels({ credentials });
  if (credential?.kind === "builtin" && !models.getProvider(credential.providerId)) throw Object.assign(new Error("Pi Durable provider is not configured by this adapter"), { code: "incompatible_configuration" });
  if (init.probe) return { status: "healthy", ...(init.probe.includeModels ? { reasoning: {
    updateMode: "unsupported", models: models.getModels().slice(0, 1024).map((model: any) => ({
      id: `${model.provider}/${model.id}`, displayName: model.name,
      supportedReasoningEfforts: getSupportedThinkingLevels(model).map((value: string) => ({ value })),
    })),
  } } : {}) };
  const { mkdirSync } = await load("node:fs");
  const { join } = await load("node:path");
  const directory = join(init.cwd, ".alook", "pi-durable");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = new DatabaseSync(join(directory, "owner.sqlite"));
  try { owner.exec("BEGIN EXCLUSIVE"); }
  catch { owner.close(); throw Object.assign(new Error("Pi Durable storage already has a live driver"), { code: "runtime_busy" }); }
  const { BACKGROUND_CONTEXT: context } = await peer("@earendil-works/chord/context");
  const { openNodeSqliteStorage } = await peer("@earendil-works/pi-durable/storage/sqlite/node");
  const { NodeExecutionEnv } = await peer("@earendil-works/pi-durable/env/node");
  const { CodingTools } = await peer("@earendil-works/pi-durable/tools");
  const registry = sdk.createRegistry();
  registry.install(CodingTools);
  let harness: any;
  let conversation: any;
  let watch: any;
  let closed = false;
  let active: { owner: string; root: string; pending: Set<string>; rootResult?: any; interrupted: boolean } | undefined;
  let view: any;
  let settling = false;
  const seenEntries = new Set<number>();
  const tools = new Map<string, string>();
  let partialKey = "";
  let partialText = "";
  let partialReasoning = "";
  let compacting = false;
  const metric = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const entry = (value: any) => {
    if (seenEntries.has(value.id)) return;
    seenEntries.add(value.id);
    if (!active) return;
    for (const message of value.model ?? []) {
      if (message.role === "assistant") {
        const text = (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
        const reasoning = (message.content ?? []).filter((block: any) => block.type === "thinking").map((block: any) => block.thinking).join("");
        if (text) emit({ kind: "assistant_message_completed", text });
        if (reasoning) emit({ kind: "assistant_reasoning_completed", text: reasoning });
        partialText = ""; partialReasoning = "";
        for (const block of message.content ?? []) {
          if (block.type === "toolCall" && !tools.has(block.id)) {
            tools.set(block.id, block.name);
            emit({ kind: "tool_call", callId: block.id, name: block.name, input: block.arguments });
          }
        }
        if (message.usage) emit({ kind: "telemetry", name: "token_usage", source: "pi_durable_assistant_entry", usage: {
          input: metric(message.usage.input), output: metric(message.usage.output),
          cache: metric(message.usage.cacheRead) !== null && metric(message.usage.cacheWrite) !== null ? message.usage.cacheRead + message.usage.cacheWrite : null,
        } });
      } else if (message.role === "toolResult" && tools.has(message.toolCallId)) {
        emit({ kind: "tool_output", callId: message.toolCallId, name: tools.get(message.toolCallId)! });
        tools.delete(message.toolCallId);
      }
    }
  };
  const project = (next: any) => {
    view = next;
    for (const value of next.entries ?? []) entry(value);
    if (!active) return;
    const live = next.docs?.["pi.live"] ?? {};
    const key = `${live.run?.taskId ?? ""}:${live.generation?.attempt ?? ""}`;
    if (key !== partialKey) { partialKey = key; partialText = ""; partialReasoning = ""; }
    const blocks = live.generation?.message?.content ?? [];
    const text = blocks.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
    const reasoning = blocks.filter((block: any) => block.type === "thinking").map((block: any) => block.thinking).join("");
    if (text.startsWith(partialText) && text.length > partialText.length) emit({ kind: "assistant_message_delta", text: text.slice(partialText.length) });
    if (reasoning.startsWith(partialReasoning) && reasoning.length > partialReasoning.length) emit({ kind: "assistant_reasoning_delta", text: reasoning.slice(partialReasoning.length) });
    partialText = text; partialReasoning = reasoning;
    for (const slot of live.tools ?? []) {
      if (slot.status !== "running" || tools.has(slot.callId)) continue;
      tools.set(slot.callId, slot.name);
      emit({ kind: "tool_call", callId: slot.callId, name: slot.name, input: null });
    }
    const nowCompacting = (live.compactions ?? []).some((item: any) => item.blocking);
    if (nowCompacting !== compacting) { compacting = nowCompacting; emit({ kind: nowCompacting ? "compaction_started" : "compaction_finished" }); }
    const visible = new Set<number>((next.entries ?? []).map((item: any) => item.id));
    for (const id of seenEntries) if (!visible.has(id)) seenEntries.delete(id);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await watch?.stop();
      await harness?.close(context);
    } finally { try { owner.exec("ROLLBACK"); } finally { owner.close(); } }
  };
  try {
    const storage = await openNodeSqliteStorage(join(directory, "state.sqlite"));
    harness = await sdk.Harness.open(storage, { models, registry, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? init.cwd, shellEnv: process.env }),
      onReport: (report: any) => { if (!closed) emit({ kind: "runtime_diagnostic", severity: "warning", source: "pi-durable", message: report?.message ?? report?.error?.message ?? "Pi Durable reported a task condition" }); },
    }, context);
    if (init.sessionId) {
      const id = /^[1-9]\d*$/.test(init.sessionId) ? Number(init.sessionId) : NaN;
      if (!Number.isSafeInteger(id)) throw Object.assign(new Error("Pi Durable conversation id is invalid"), { code: "reset_required" });
      conversation = await harness.conversation(id, context);
      if (!conversation) throw Object.assign(new Error("Pi Durable conversation history is missing"), { code: "reset_required" });
    }
    const selected = init.config.model;
    let modelRef: { provider: string; modelId: string } | undefined;
    if (selected) {
      const slash = selected.indexOf("/");
      if (slash < 1) throw Object.assign(new Error("Pi Durable models use provider/model format"), { code: "incompatible_configuration" });
      modelRef = { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) };
      const nativeModel = models.getModel(modelRef.provider, modelRef.modelId);
      if (!nativeModel || (init.config.reasoningEffort && !getSupportedThinkingLevels(nativeModel).includes(init.config.reasoningEffort))) throw Object.assign(new Error("Pi Durable did not advertise the selected model or effort"), { code: "incompatible_configuration" });
    } else if (!conversation) throw Object.assign(new Error("Pi Durable requires an explicit model selection"), { code: "incompatible_configuration" });
    const agent = { cwd: init.cwd, instructions: init.instructions ?? "", ...(modelRef ? { model: modelRef } : {}), ...(init.config.reasoningEffort ? { thinkingLevel: init.config.reasoningEffort } : {}) };
    if (!conversation) conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    else {
      const existing = await conversation.agent(context);
      const snapshot = await conversation.watch(context);
      const busy = Boolean(snapshot.value.docs?.["pi.live"]?.run);
      await snapshot.stop();
      if (busy && (existing.cwd !== agent.cwd || existing.instructions !== agent.instructions || (modelRef && JSON.stringify(existing.model) !== JSON.stringify(modelRef)) || (init.config.reasoningEffort && existing.thinkingLevel !== init.config.reasoningEffort))) {
        throw Object.assign(new Error("Pi Durable cannot change saved settings while adopting an active run"), { code: "incompatible_configuration" });
      }
      if (!busy) await conversation.configure(agent, context);
    }
    watch = await conversation.watch(context);
    view = watch.value;
    for (const value of view.entries ?? []) seenEntries.add(value.id);
    watch.start(async (call: any) => { if (call.kind === "value") project(call.value); else emit({ kind: "runtime_diagnostic", severity: "warning", source: "pi-durable", message: "Pi Durable state observation temporarily failed" }); });
    void watch.closed.then((end: any) => { if (!closed) emit({ kind: "worker_error", code: "pi_durable_watch_ended", message: end?.error?.message ?? "Pi Durable observation ended" }); });
    harness.resume();
  } catch (error) { await close(); throw error; }
  const settleRoot = async () => {
    if (settling || !active || active.pending.size || !active.rootResult) return;
    settling = true;
    const root = active;
    try {
      await conversation.waitForIdle(context);
      if (closed || active !== root || root.pending.size) return;
      active = undefined;
      const result = root.rootResult;
      for (const [callId, name] of tools) emit({ kind: "tool_output", callId, name });
      tools.clear();
      const interrupted = root.interrupted || /abort|interrupt/.test(result.reason ?? "");
      if (result.status !== "done" && !interrupted) emit({ kind: "error", code: "pi_durable_unanswered", message: `Pi Durable could not answer the root input: ${String(result.reason ?? "unknown")}` });
      emit({ kind: "turn_end", sessionId: String(conversation.id), turnOwner: root.owner, ...(interrupted ? { outcome: "interrupted" as const } : {}) });
    } catch (error) { if (!closed) emit({ kind: "worker_error", code: "pi_durable_settlement_failed", message: error instanceof Error ? error.message : "Pi Durable settlement failed" }); }
    finally { settling = false; }
  };
  return {
    sessionId: String(conversation.id),
    async send(input: LaneSendInput) {
      if (closed) return { ok: false, reason: "closed" };
      if (input.mode === "busy" && !active) return { ok: false, reason: "runtime_busy" };
      if (input.mode === "idle" && active) return { ok: false, reason: "runtime_busy" };
      const { randomUUID } = await load("node:crypto");
      const requestId = `alook:${randomUUID()}`;
      const root: NonNullable<typeof active> = active ?? { owner: input.terminalOwner ?? requestId, root: requestId, pending: new Set<string>(), interrupted: false };
      root.pending.add(requestId);
      active = root;
      let submission: any;
      try { submission = await conversation.submit({ type: "input", content: input.text, requestId, whenBusy: "steer", ...(input.mode === "busy" ? { whenIdle: "reject" } : {}) }, context); }
      catch (error) {
        root.pending.delete(requestId);
        if (root.root === requestId) active = undefined;
        if (/ConversationBusy|ConversationIdle/.test((error as Error)?.name ?? "")) return { ok: false, reason: "runtime_busy" };
        throw error;
      }
      project(view);
      void submission.wait(context).then((result: any) => {
        if (closed || active !== root) return;
        root.pending.delete(requestId);
        if (requestId === root.root) root.rootResult = result;
        if (result.status === "unanswered") emit({ kind: "error", code: "pi_durable_input_unanswered", message: `Pi Durable returned an unanswered input: ${String(result.reason)}` });
        void settleRoot();
      }).catch((error: unknown) => { if (!closed) emit({ kind: "worker_error", code: "pi_durable_submission_failed", message: error instanceof Error ? error.message : "Pi Durable submission status failed" }); });
      return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt", receipt: root.owner };
    },
    async interrupt() { if (!active) return false; active.interrupted = true; await conversation.abort(context, { background: true }); return true; },
    close,
  };
}
