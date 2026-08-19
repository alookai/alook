import { describe, it, expect } from "vitest";
import { runtimeDisplayName, GENERIC_RUNTIME_NAME } from "./runtime-display";

describe("runtimeDisplayName", () => {
  it("maps known providers to friendly names", () => {
    expect(runtimeDisplayName("claude")).toBe("Claude Code");
    expect(runtimeDisplayName("codex")).toBe("Codex");
    expect(runtimeDisplayName("opencode")).toBe("OpenCode");
  });

  it("falls back to the generic label for undefined / null", () => {
    expect(runtimeDisplayName(undefined)).toBe(GENERIC_RUNTIME_NAME);
    expect(runtimeDisplayName(null)).toBe(GENERIC_RUNTIME_NAME);
    expect(runtimeDisplayName("")).toBe(GENERIC_RUNTIME_NAME);
  });

  it("falls back to the generic label for unknown slugs", () => {
    expect(runtimeDisplayName("unknown-runtime")).toBe(GENERIC_RUNTIME_NAME);
    expect(runtimeDisplayName("CLAUDE")).toBe(GENERIC_RUNTIME_NAME); // case-sensitive by design
  });

  it("generic label reads as a sentence fragment", () => {
    expect(GENERIC_RUNTIME_NAME).toBe("the agent runtime");
  });
});
