import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "../../src/community/bot-reasoning-effort";

const runtime = {
  reasoning: {
    updateMode: "live_next_turn" as const,
    defaultModelId: "model-a",
    models: [
      {
        id: "model-a",
        supportedReasoningEfforts: [{ value: "minimal" }, { value: "xhigh" }],
        defaultReasoningEffort: "minimal",
      },
      {
        id: "model-b",
        supportedReasoningEfforts: [{ value: "low" }],
      },
    ],
  },
};

describe("resolveReasoningEffort", () => {
  it("uses the reported default model without persisting the reported default effort", () => {
    expect(resolveReasoningEffort(runtime, null, null)).toEqual({
      modelId: "model-a",
      options: [{ value: "minimal" }, { value: "xhigh" }],
      defaultReasoningEffort: "minimal",
      canonicalEffort: null,
      supported: true,
    });
  });

  it("accepts exact known and forward-compatible reported values", () => {
    expect(resolveReasoningEffort(runtime, "model-a", "xhigh").canonicalEffort).toBe("xhigh");
    const future = {
      reasoning: {
        ...runtime.reasoning,
        models: [{ id: "future", supportedReasoningEfforts: [{ value: "new_level" }] }],
      },
    };
    expect(resolveReasoningEffort(future, "future", "new_level").canonicalEffort).toBe("new_level");
  });

  it("keeps empty native metadata equivalent to the existing unreported-effort boundary", () => {
    const catalog = { reasoning: { updateMode: "unsupported" as const, models: [{ id: "native-model", supportedReasoningEfforts: [] }] } };
    const before = resolveReasoningEffort({}, "native-model", "high");
    expect(resolveReasoningEffort(catalog, "native-model", "high")).toEqual(before);
    expect(before).toMatchObject({ supported: false, canonicalEffort: null });
  });

  it("falls an incompatible or unreported explicit effort back to Default", () => {
    expect(resolveReasoningEffort(runtime, "model-b", "xhigh")).toMatchObject({
      canonicalEffort: null,
      supported: false,
    });
    expect(resolveReasoningEffort(undefined, null, "high")).toMatchObject({
      options: [],
      canonicalEffort: null,
      supported: false,
    });
  });
});
