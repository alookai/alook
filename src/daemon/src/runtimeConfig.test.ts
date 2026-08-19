import { describe, it, expect } from "vitest";
import { runtimeModelName, toAgentBackendSelection } from "./runtimeConfig";
import { makeRuntimeConfig } from "./runtimeConfig";

describe("runtimeModelName", () => {
  for (const runtime of ["claude", "codex", "cursor", "opencode", "pi"]) {
    it(`${runtime}: projects a named model without interpreting the backend`, () => {
      expect(runtimeModelName(makeRuntimeConfig({ runtime, model: { kind: "named", name: "opus" } })))
        .toBe("opus");
    });
  }

  it("projects custom models without provider or environment interpretation", () => {
    expect(runtimeModelName(makeRuntimeConfig({ runtime: "claude", model: { kind: "custom", name: "my-ft" } })))
      .toBe("my-ft");
  });

  it("returns undefined for absent and default selections", () => {
    expect(runtimeModelName(undefined)).toBeUndefined();
    expect(runtimeModelName(makeRuntimeConfig({ runtime: "cursor" }))).toBeUndefined();
  });
});

describe("toAgentBackendSelection", () => {
  it("maps every runtime into the agent-driver contract", () => {
    expect(toAgentBackendSelection(makeRuntimeConfig({ runtime: "codex" }))).toMatchObject({ backend: "codex" });
    expect(toAgentBackendSelection(makeRuntimeConfig({ runtime: "cursor" }))).toMatchObject({ backend: "cursor" });
    expect(toAgentBackendSelection(makeRuntimeConfig({ runtime: "opencode" }))).toMatchObject({ backend: "opencode" });
    expect(toAgentBackendSelection(makeRuntimeConfig({ runtime: "pi" }))).toMatchObject({
      backend: "pi",
      config: { provider: { kind: "default" } },
    });
  });

  it("maps Claude custom endpoints and Pi built-in providers", () => {
    expect(toAgentBackendSelection(makeRuntimeConfig({
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://example.invalid", apiKey: "claude-key" },
    }))).toMatchObject({
      backend: "claude",
      config: {
        provider: { kind: "custom_endpoint", apiUrl: "https://example.invalid", apiKey: "claude-key" },
      },
    });
    expect(toAgentBackendSelection(makeRuntimeConfig({
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "openai", apiKey: "pi-key" },
    }))).toMatchObject({
      backend: "pi",
      config: { provider: { kind: "builtin", providerId: "openai", apiKey: "pi-key" } },
    });
  });

  it("rejects unknown runtimes", () => {
    expect(() => toAgentBackendSelection({
      ...makeRuntimeConfig({ runtime: "claude" }),
      runtime: "unknown",
    } as never)).toThrow("Unknown runtime: unknown");
  });
});
