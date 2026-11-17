import { describe, expect, it } from "vitest";
import { acpModelObservation, messageModelObservation, modelObservation } from "./model-observation.js";
import { ClaudeEventNormalizer } from "../adapters/claude/normalizer.js";
import { mapPiSdkEvent } from "../adapters/pi/index.js";
import { CodexEventNormalizer } from "../adapters/codex/normalizer.js";

describe("native model evidence", () => {
  it("keeps each assistant response even without content or usage, including child ownership", () => {
    const claude = new ClaudeEventNormalizer();
    const parse = (id: string, parent?: string) => claude.normalizeLine(JSON.stringify({ type: "assistant", parent_tool_use_id: parent,
      message: { id, model: "served-model", content: [] } }));
    expect([parse("one"), parse("two")].flat()).toEqual([
      { kind: "model_observed", observation: { model: "served-model", source: "response", responseId: "one" } },
      { kind: "model_observed", observation: { model: "served-model", source: "response", responseId: "two" } },
    ]);
    expect(parse("child", "task-A")).toEqual([{ kind: "model_observed", observation: {
      model: "served-model", source: "response", responseId: "child",
    }, attribution: { scope: "child", parentCallId: "task-A" } }]);
    expect(mapPiSdkEvent({ type: "message_end", message: { role: "assistant", model: "actual", provider: "upstream", responseId: "reply" } }, "native", { sawTextDelta: false }))
      .toEqual([{ kind: "model_observed", observation: { model: "actual", provider: "upstream", source: "response", responseId: "reply" } }]);
  });

  it("reads native current values without converting selectors or requested parameters into evidence", () => {
    expect(acpModelObservation({ configOptions: [{ id: "model", currentValue: "auto" }] })?.observation).toEqual({ model: "auto", source: "session" });
    expect(acpModelObservation({ _meta: { model: "native-fallback" }, modelId: "requested" })?.observation.model).toBe("native-fallback");
    expect(acpModelObservation({ sessionUpdate: "current_model_update", modelId: "changed" })?.observation.model).toBe("changed");
    expect(acpModelObservation({ model: "requested", modelId: "requested", models: { availableModels: [{ modelId: "first" }] } })).toBeUndefined();
    expect(messageModelObservation({ role: "assistant", id: "message", modelID: "served", providerID: "native" })?.observation)
      .toEqual({ model: "served", provider: "native", source: "response", responseId: "message" });
    for (const value of [undefined, "", "bad\nmodel", "x".repeat(257), { id: "hidden" }]) expect(modelObservation(value, "response")).toBeUndefined();
  });

  it("keeps Codex native settings updates out of foreign thread authority", () => {
    const codex = new CodexEventNormalizer();
    codex.normalizeLine(JSON.stringify({ id: 1, result: { thread: { id: "root" } } }));
    const update = (threadId: string) => codex.normalizeLine(JSON.stringify({ method: "thread/settings/updated", params: { threadId, threadSettings: { model: "native-model" } } }));
    expect(update("root")).toEqual([{ kind: "model_observed", observation: { model: "native-model", source: "session" } }]);
    expect(update("child")).toEqual([{ kind: "model_observed", observation: { model: "native-model", source: "session" }, attribution: { scope: "unknown", agentId: "child" } }]);
  });
});
