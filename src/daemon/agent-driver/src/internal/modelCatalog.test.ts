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

  it("returns no catalog instead of truncating when unique IDs overflow the bound", () => {
    const opencode = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => `provider/model-${index}`,
    ).join("\n");
    const pi = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => ({ provider: "provider", id: `model-${index}` }),
    );

    expect(parseOpenCodeModelCatalog(opencode)).toBeUndefined();
    expect(parsePiModelCatalog(pi)).toBeUndefined();
  });
});
