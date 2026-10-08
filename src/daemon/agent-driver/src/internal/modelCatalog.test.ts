import { describe, expect, it } from "vitest";
import {
  parseOpenCodeModelCatalog,
  parsePiModelCatalog,
  RUNTIME_MODEL_CATALOG_MAX,
} from "./modelCatalog.js";

function ids(catalog: ReturnType<typeof parseOpenCodeModelCatalog>): string[] | undefined {
  return catalog?.models.map((model) => model.id);
}

describe("runtime startup model catalog parsers", () => {
  it("parses only OpenCode provider/model rows and deduplicates them", () => {
    expect(ids(parseOpenCodeModelCatalog([
      "openai/gpt-5",
      "anthropic/claude-sonnet",
      "openai/gpt-5",
      "header without slash",
      "bad provider/model with spaces",
    ].join("\n")))).toEqual(["openai/gpt-5", "anthropic/claude-sonnet"]);
  });

  it("formats only valid Pi getAvailable entries as provider/id", () => {
    expect(ids(parsePiModelCatalog([
      { provider: "google", id: "gemini-2.5-pro" },
      { provider: "openai", id: "gpt-5" },
      { provider: "openai", id: "gpt-5" },
      { provider: "bad/provider", id: "model" },
      { provider: "missing-id" },
    ]))).toEqual(["google/gemini-2.5-pro", "openai/gpt-5"]);
  });

  it("returns no catalog for empty or wholly malformed producer output", () => {
    expect(parseOpenCodeModelCatalog("not a model\n")).toBeUndefined();
    expect(parsePiModelCatalog([{ nope: true }])).toBeUndefined();
  });

  it("preserves a 598-model OpenCode catalog without losing its first or last model", () => {
    const models = Array.from({ length: 598 }, (_, index) => `provider/model-${index}`);
    expect(ids(parseOpenCodeModelCatalog([...models, models[0]!].join("\n")))).toEqual(models);
  });

  it("accepts the complete catalog at the bound for both producers", () => {
    const models = Array.from({ length: RUNTIME_MODEL_CATALOG_MAX }, (_, index) => `provider/model-${index}`);
    expect(ids(parseOpenCodeModelCatalog(models.join("\n")))).toEqual(models);
    expect(ids(parsePiModelCatalog(models.map((id) => ({ provider: "provider", id: id.slice(9) }))))).toEqual(models);
  });

  it("retains the first valid unique IDs when producer catalogs overflow", () => {
    const opencode = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => `provider/model-${index}`,
    ).join("\n");
    const pi = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => ({ provider: "provider", id: `model-${index}` }),
    );

    const expected = Array.from({ length: RUNTIME_MODEL_CATALOG_MAX }, (_, index) => `provider/model-${index}`);
    expect(ids(parseOpenCodeModelCatalog(`invalid row\nprovider/model-0\n${opencode}`))).toEqual(expected);
    expect(ids(parsePiModelCatalog([null, pi[0], ...pi]))).toEqual(expected);
  });
});
