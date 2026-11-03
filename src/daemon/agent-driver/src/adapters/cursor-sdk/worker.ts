import type { SdkWorkerInit, SdkWorkerSession, SdkWorkerEvent as AdapterEvent } from "../../internal/sdk-worker-api.js";
import type { LaneSendInput, ProbeResult } from "../../internal/adapter.js";

export async function cursorSdkWorker(init: SdkWorkerInit, emit: (event: AdapterEvent) => void): Promise<SdkWorkerSession | ProbeResult> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const module = await load(init.moduleUrl);
  const sdk = module.Agent ? module : module.default;
  if (typeof sdk?.Agent?.create !== "function" || typeof sdk?.Agent?.resume !== "function" || typeof sdk?.Cursor?.models?.list !== "function" || typeof sdk?.JsonlLocalAgentStore !== "function") {
    throw Object.assign(new Error("Cursor SDK lacks persistent local sessions or its JSONL store"), { code: "incompatible_configuration" });
  }
  const catalog = async () => {
    const items = await sdk.Cursor.models.list();
    return items.filter((model: any) => typeof model.id === "string").slice(0, 1024).map((model: any) => {
      const parameter = model.parameters?.find((item: any) => /reason|effort|thinking/i.test(item.id));
      return {
        id: model.id, displayName: model.displayName,
        supportedReasoningEfforts: parameter?.values?.map((item: any) => ({ value: item.value, ...(item.displayName ? { description: item.displayName } : {}) })) ?? [],
      };
    });
  };
  if (init.probe) return {
    status: "healthy",
    ...(init.probe.includeModels ? { reasoning: { updateMode: "unsupported", models: await catalog() } } : {}),
  };
  const { join } = await load("node:path");
  if (!init.sessionId && !init.config.model) throw Object.assign(new Error("Cursor SDK requires an explicit local model selection"), { code: "incompatible_configuration" });
  let model = init.config.model ? { id: init.config.model } as { id: string; params?: { id: string; value: string }[] } : undefined;
  if (init.config.reasoningEffort) {
    const native = (await sdk.Cursor.models.list()).find((entry: any) => entry.id === init.config.model);
    const parameter = native?.parameters?.find((item: any) => /reason|effort|thinking/i.test(item.id));
    if (!model || !parameter?.values?.some((item: any) => item.value === init.config.reasoningEffort)) {
      throw Object.assign(new Error("Cursor SDK did not advertise the selected reasoning effort"), { code: "incompatible_configuration" });
    }
    model = { ...model, params: [{ id: parameter.id, value: init.config.reasoningEffort }] };
  }
  const options = {
    ...(model ? { model } : {}),
    local: { cwd: init.cwd, store: new sdk.JsonlLocalAgentStore(join(init.cwd, ".alook", "cursor-sdk")), settingSources: ["project"], sandboxOptions: { enabled: false } },
  };
  let agent: any;
  try { agent = init.sessionId ? await sdk.Agent.resume(init.sessionId, options) : await sdk.Agent.create(options); }
  catch (error) {
    if (init.sessionId && (error as Error)?.name === "AgentNotFoundError") throw Object.assign(new Error("Cursor SDK session history is missing"), { code: "reset_required" });
    throw error;
  }
  if (typeof agent.agentId !== "string" || (init.sessionId && agent.agentId !== init.sessionId)) {
    await agent.close();
    throw Object.assign(new Error("Cursor SDK did not restore the requested agent"), { code: "reset_required" });
  }
  if (typeof agent.model?.id === "string") emit({ kind: "configuration_observed", observation: { evidence: "observed", effective: "current", model: agent.model.id } });
  let active: any;
  let closed = false;
  return {
    sessionId: agent.agentId,
    acquisition: { status: init.sessionId ? "resumed" : "created", evidence: "native_api" },
    async send(input: LaneSendInput) {
      if (closed) return { ok: false, reason: "closed" };
      const receipt = input.terminalOwner ?? active?.id;
      if (input.mode === "busy") {
        if (!active || typeof active.steer !== "function") return { ok: false, reason: "runtime_busy" };
        const outcome = await active.steer(input.text);
        return outcome === "complete_delivered"
          ? { ok: true, acceptedAs: "steer", receipt }
          : { ok: false, reason: "runtime_busy", error: "Cursor SDK returned the input for follow-up delivery" };
      }
      if (active) return { ok: false, reason: "runtime_busy" };
      let textSeen = false;
      let terminal = false;
      const tools = new Map<string, string>();
      const run = await agent.send(input.text, { onDelta({ update }: { update: any }) {
        if (closed || terminal) return;
        if (update.type === "text-delta" && typeof update.text === "string") {
          textSeen = true; emit({ kind: "assistant_message_delta", text: update.text });
        } else if (update.type === "thinking-delta" && typeof update.text === "string") emit({ kind: "assistant_reasoning_delta", text: update.text });
        else if (update.type === "tool-call-started" && typeof update.callId === "string") {
          const name = update.toolCall?.type ?? "unknown_tool";
          tools.set(update.callId, name);
          emit({ kind: "tool_call", callId: update.callId, name, input: update.toolCall?.args ?? {} });
        } else if (update.type === "tool-call-completed" && typeof update.callId === "string" && tools.has(update.callId)) {
          emit({ kind: "tool_output", callId: update.callId, name: tools.get(update.callId)!, outcome: update.toolCall?.result?.status === "success" ? "success" : update.toolCall?.result?.status === "error" ? "failed" : "unknown", output: update.toolCall?.result });
          tools.delete(update.callId);
        }
      } });
      active = run;
      const owner = input.terminalOwner ?? run.id;
      emit({ kind: "turn_owner", receipt: owner, nativeTurnId: run.id });
      void Promise.resolve().then(() => run.wait()).then(async (result: any) => {
        if (closed || active !== run) return;
        terminal = true; active = undefined;
        if (!textSeen && typeof result.result === "string") emit({ kind: "assistant_message_completed", text: result.result });
        if (result.usage) {
          const metric = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
          const read = metric(result.usage.cacheReadTokens);
          const write = metric(result.usage.cacheWriteTokens);
          emit({ kind: "telemetry", name: "token_usage", source: "cursor_sdk_run", usage: {
            input: metric(result.usage.inputTokens), output: metric(result.usage.outputTokens),
            cache: read !== null && write !== null ? read + write : null,
          } });
        }
        if (result.status === "error") emit({ kind: "error", code: "cursor_sdk_run_failed", message: result.error?.message ?? "Cursor SDK run failed" });
        emit({ kind: "turn_end", sessionId: agent.agentId, turnOwner: owner, outcome: result.status === "cancelled" ? "interrupted" : result.status === "error" ? "failed" : result.status === "finished" ? "success" : "unknown" });
      }).catch((error: unknown) => {
        if (closed || active !== run) return;
        terminal = true; active = undefined;
        emit({ kind: "error", message: error instanceof Error ? error.message : "Cursor SDK run failed" });
        emit({ kind: "turn_end", sessionId: agent.agentId, turnOwner: owner, outcome: "failed" });
      });
      return { ok: true, acceptedAs: "prompt", receipt: owner };
    },
    async interrupt() { if (!active) return false; await active.cancel(); return true; },
    async close() { closed = true; if (active) await active.cancel(); await agent.close(); },
  };
}
