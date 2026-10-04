import { describe, expect, it } from "vitest";
import { antigravityModelForEffort, antigravityReasoningCatalog, parseAntigravityCatalog } from "./catalog.js";

describe("Antigravity native model variants", () => {
  it("preserves returned choices and maps effort only to offered siblings", () => {
    const models = ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-low", "other-high"];
    const catalog = parseAntigravityCatalog({ models: { currentModelId: models[0], availableModels: models.map((modelId) => ({ modelId, name: modelId })) } })!;
    const publicCatalog = antigravityReasoningCatalog(catalog);
    expect(publicCatalog.defaultModelId).toBe(models[0]);
    expect(publicCatalog.models[0]?.supportedReasoningEfforts).toEqual([{ value: "high" }, { value: "low" }]);
    expect(publicCatalog.models[3]?.supportedReasoningEfforts).toEqual([]);
    expect(antigravityModelForEffort(catalog, models[0]!, "low")).toBe(models[1]);
    expect(antigravityModelForEffort(catalog, models[2]!, "high")).toBeUndefined();
    expect(antigravityModelForEffort(catalog, "other-high", "high")).toBeUndefined();
    expect(antigravityModelForEffort(catalog, models[0]!)).toBe(models[0]);
  });

  it("prefers config options, flattens groups, deduplicates and bounds metadata", () => {
    expect(parseAntigravityCatalog({ models: { availableModels: [{ modelId: "stale" }] }, configOptions: [{
      id: "native-model", category: "model", type: "select", currentValue: "actual",
      options: [{ group: "g", options: [{ value: "actual", name: "Actual" }, { value: "actual" }, { value: "invalid model" }] }],
    }] })).toEqual({ configId: "native-model", currentModelId: "actual", models: [{ id: "actual", displayName: "Actual" }] });
    expect(parseAntigravityCatalog({ models: { availableModels: Array.from({ length: 513 }, (_, i) => ({ modelId: `model-${i}` })) } })).toBeUndefined();
    expect(parseAntigravityCatalog(null)).toBeUndefined();
  });
});
