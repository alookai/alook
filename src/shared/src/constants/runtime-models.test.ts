import { describe, it, expect } from "vitest";
import {
  RUNTIME_MODEL_CATALOG,
  getRuntimeModelCatalog,
  runtimeSupportsModel,
} from "./runtime-models";

const SEEDED_RUNTIMES = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "copilot",
  "cursor",
  "opencode",
  "pi",
  "antigravity",
];

describe("getRuntimeModelCatalog", () => {
  it("returns the seeded entry for each of the 9 runtime ids", () => {
    for (const id of SEEDED_RUNTIMES) {
      expect(getRuntimeModelCatalog(id)).toBe(RUNTIME_MODEL_CATALOG[id]);
    }
    expect(getRuntimeModelCatalog("claude").models).toContain("claude-opus-4-6");
    expect(getRuntimeModelCatalog("codex").models).toContain("gpt-5.4");
    expect(getRuntimeModelCatalog("gemini").models).toEqual([]);
  });

  it("falls back to {supportsModel:true, models:[]} for an unknown id and null", () => {
    expect(getRuntimeModelCatalog("does-not-exist")).toEqual({ supportsModel: true, models: [] });
    expect(getRuntimeModelCatalog(null)).toEqual({ supportsModel: true, models: [] });
  });
});

describe("runtimeSupportsModel", () => {
  it("is false only for antigravity", () => {
    expect(runtimeSupportsModel("antigravity")).toBe(false);
    for (const id of SEEDED_RUNTIMES.filter((r) => r !== "antigravity")) {
      expect(runtimeSupportsModel(id)).toBe(true);
    }
    expect(runtimeSupportsModel(null)).toBe(true);
    expect(runtimeSupportsModel("unknown-runtime")).toBe(true);
  });
});
