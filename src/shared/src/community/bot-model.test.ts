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
      expect(resolveModelConfig(v)).toEqual({ kind: "default" });
    }
  });

  it("resolves every non-empty stored model as launchable named config", () => {
    expect(resolveModelConfig("opus")).toEqual({
      kind: "named",
      name: "opus",
    });
    expect(resolveModelConfig("my-ft")).toEqual({ kind: "named", name: "my-ft" });
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
    const s = modelSelectState(["opus", "sonnet", "haiku"], null);
    expect(s).toEqual({ selectValue: MODEL_SELECT_DEFAULT, customName: "" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBeNull();
  });
  it("round-trips a catalog id", () => {
    const s = modelSelectState(["opus", "sonnet", "haiku"], "opus");
    expect(s).toEqual({ selectValue: "opus", customName: "" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBe("opus");
  });
  it("round-trips a custom name", () => {
    const s = modelSelectState(["opus", "sonnet", "haiku"], "my-ft");
    expect(s).toEqual({ selectValue: MODEL_SELECT_CUSTOM, customName: "my-ft" });
    expect(modelNameFromSelect(s.selectValue, s.customName)).toBe("my-ft");
  });
  it("maps a cleared select (null) and an empty custom to null", () => {
    expect(modelNameFromSelect(null, "ignored")).toBeNull();
    expect(modelNameFromSelect(MODEL_SELECT_CUSTOM, "")).toBeNull();
    expect(modelNameFromSelect(MODEL_SELECT_CUSTOM, "   ")).toBeNull();
  });
});
