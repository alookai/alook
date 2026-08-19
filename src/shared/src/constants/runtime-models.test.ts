import { describe, it, expect } from "vitest";
import {
  RUNTIME_MODEL_CATALOG,
  getRuntimeModelCatalog,
} from "./runtime-models";

const SEEDED_RUNTIMES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
];

describe("getRuntimeModelCatalog", () => {
  it("returns the seeded entry for each of the 5 supported runtime ids", () => {
    for (const id of SEEDED_RUNTIMES) {
      expect(getRuntimeModelCatalog(id)).toBe(RUNTIME_MODEL_CATALOG[id]);
    }
    expect(getRuntimeModelCatalog("claude").models).toContain("claude-opus-4-6");
    expect(getRuntimeModelCatalog("codex").models).toContain("gpt-5.4");
    expect(getRuntimeModelCatalog("cursor").models).toEqual([]);
  });

  it("falls back to {models:[]} for an unknown id and null", () => {
    expect(getRuntimeModelCatalog("does-not-exist")).toEqual({ models: [] });
    expect(getRuntimeModelCatalog(null)).toEqual({ models: [] });
  });
});
