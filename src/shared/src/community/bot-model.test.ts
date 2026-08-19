import { describe, it, expect } from "vitest";
import {
  resolveModelConfig,
  formatModelLabel,
  modelSelectState,
  modelNameFromSelect,
  MODEL_SELECT_DEFAULT,
  MODEL_SELECT_CUSTOM,
} from "./bot-model";

describe("resolveModelConfig", () => {
  it("treats null, empty, and whitespace-only as default", () => {
    for (const v of [null, "", "   "]) {
      expect(resolveModelConfig("claude", v)).toEqual({ kind: "default" });
    }
  });

  it("resolves a catalog id to named and a non-catalog id to custom", () => {
    expect(resolveModelConfig("claude", "claude-opus-4-6")).toEqual({
      kind: "named",
      name: "claude-opus-4-6",
    });
    expect(resolveModelConfig("claude", "my-ft")).toEqual({ kind: "custom", name: "my-ft" });
    // Empty catalog ⇒ always custom.
    expect(resolveModelConfig("cursor", "anything")).toEqual({ kind: "custom", name: "anything" });
    // Null runtime ⇒ fallback empty catalog ⇒ custom.
    expect(resolveModelConfig(null, "x")).toEqual({ kind: "custom", name: "x" });
  });

  it("a model added to the catalog later resolves custom → named with no stored change (derive-at-read)", () => {
    // Same stored string; membership decides the kind. Simulate a not-yet-catalogued
    // id (custom) vs a catalogued id (named) without mutating storage.
    expect(resolveModelConfig("codex", "gpt-6-future")).toEqual({ kind: "custom", name: "gpt-6-future" });
    expect(resolveModelConfig("codex", "gpt-5.4")).toEqual({ kind: "named", name: "gpt-5.4" });
  });
});

describe("formatModelLabel", () => {
  it("strips exactly one runtime- prefix", () => {
    expect(formatModelLabel("claude", "claude-opus-4-6")).toBe("opus-4-6");
  });
  it("leaves a non-prefixed id unchanged", () => {
    expect(formatModelLabel("codex", "gpt-5.4")).toBe("gpt-5.4");
  });
  it("returns null for a default (null) model", () => {
    expect(formatModelLabel("claude", null)).toBeNull();
    expect(formatModelLabel(null, null)).toBeNull();
  });
  it("never empties a name equal to the bare runtime", () => {
    expect(formatModelLabel("claude", "claude")).toBe("claude");
  });
});

describe("modelSelectState / modelNameFromSelect round-trip", () => {
  it("round-trips default", () => {
    const s = modelSelectState("claude", null);
    expect(s).toEqual({ selectValue: MODEL_SELECT_DEFAULT, customName: "" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBeNull();
  });
  it("round-trips a catalog id", () => {
    const s = modelSelectState("claude", "claude-opus-4-6");
    expect(s).toEqual({ selectValue: "claude-opus-4-6", customName: "" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBe("claude-opus-4-6");
  });
  it("round-trips a custom name", () => {
    const s = modelSelectState("claude", "my-ft");
    expect(s).toEqual({ selectValue: MODEL_SELECT_CUSTOM, customName: "my-ft" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBe("my-ft");
  });
  it("maps a cleared select (null) and an empty custom to null", () => {
    expect(modelNameFromSelect(null, "ignored")).toBeNull();
    expect(modelNameFromSelect(MODEL_SELECT_CUSTOM, "")).toBeNull();
    expect(modelNameFromSelect(MODEL_SELECT_CUSTOM, "   ")).toBeNull();
  });
});
