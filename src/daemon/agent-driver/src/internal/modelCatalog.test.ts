import { describe, expect, it } from "vitest";
import {
  parseCursorModelCatalog,
  parseOpenCodeModelCatalog,
  parsePiModelCatalog,
  RUNTIME_MODEL_CATALOG_MAX,
} from "./modelCatalog.js";

function ids(catalog: ReturnType<typeof parseCursorModelCatalog>): string[] | undefined {
  return catalog?.models.map((model) => model.id);
}

describe("runtime startup model catalog parsers", () => {
  it("parses Cursor id-label rows and ignores headers, tips, malformed rows, and duplicates", () => {
    expect(ids(parseCursorModelCatalog([
      "Available models",
      "",
      "gpt-5.6-sol - GPT 5.6 Sol",
      "not a model row",
      "gpt-5.6-sol - duplicate",
      "claude-4.6-opus - Claude Opus",
      "Tip: choose with --model",
    ].join("\n")))).toEqual(["gpt-5.6-sol", "claude-4.6-opus"]);
  });

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
    expect(parseCursorModelCatalog("Available models\nTip: log in")).toBeUndefined();
    expect(parseOpenCodeModelCatalog("not a model\n")).toBeUndefined();
    expect(parsePiModelCatalog([{ nope: true }])).toBeUndefined();
  });

  it("returns no catalog instead of truncating when unique IDs overflow the bound", () => {
    const cursor = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => `model-${index} - Model ${index}`,
    ).join("\n");
    const opencode = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => `provider/model-${index}`,
    ).join("\n");
    const pi = Array.from(
      { length: RUNTIME_MODEL_CATALOG_MAX + 1 },
      (_, index) => ({ provider: "provider", id: `model-${index}` }),
    );

    expect(parseCursorModelCatalog(cursor)).toBeUndefined();
    expect(parseOpenCodeModelCatalog(opencode)).toBeUndefined();
    expect(parsePiModelCatalog(pi)).toBeUndefined();
  });
});
