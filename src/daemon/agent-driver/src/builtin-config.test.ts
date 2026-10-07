import { describe, expect, it } from "vitest";
import { toBuiltinBackendSelection, type BuiltinRuntimeConfigInput } from "./builtin-config.js";

function config(runtime: string, overrides: Partial<BuiltinRuntimeConfigInput> = {}): BuiltinRuntimeConfigInput {
  return {
    runtime,
    model: { kind: "default" },
    mode: { kind: "default" },
    ...overrides,
  };
}

describe("builtin config boundary", () => {
  it("owns Claude endpoint and Pi provider interpretation inside the package", () => {
    expect(toBuiltinBackendSelection(config("claude", {
      provider: { kind: "custom", apiUrl: "https://example.invalid", apiKey: "claude-key" },
    }))).toMatchObject({
      backend: "claude",
      config: { provider: { kind: "custom_endpoint", apiUrl: "https://example.invalid", apiKey: "claude-key" } },
    });
    expect(toBuiltinBackendSelection(config("pi", {
      provider: { kind: "pi-builtin", providerId: "openai", apiKey: "pi-key" },
    }))).toMatchObject({
      backend: "pi",
      config: { provider: { kind: "builtin", providerId: "openai", apiKey: "pi-key" } },
    });
    expect(toBuiltinBackendSelection(config("claude", {
      provider: { kind: "default" },
    }))).toMatchObject({
      backend: "claude",
      config: { provider: { kind: "default" } },
    });
  });

  it.each(["codex", "cursor", "grok", "opencode", "pi"])("maps %s without daemon-side switches", (runtime) => {
    expect(toBuiltinBackendSelection(config(runtime))).toMatchObject({ backend: runtime });
  });

  it("maps Grok reasoning without provider configuration", () => {
    expect(toBuiltinBackendSelection(config("grok", {
      reasoningEffort: "xhigh",
      provider: { kind: "custom", apiUrl: "https://example.invalid", apiKey: "must-not-leak" },
    }))).toEqual({
      backend: "grok",
      config: {
        model: { kind: "default" },
        command: undefined,
        environment: undefined,
        reasoningEffort: "xhigh",
      },
    });
  });

  it("rejects unknown runtime ids", () => {
    expect(() => toBuiltinBackendSelection(config("unknown"))).toThrow("Unknown runtime: unknown");
  });

  it.each([{ kind: "default" } as const, { kind: "named", name: "gemini-3.8-flash-high" } as const])(
    "forwards Antigravity native model, effort and launch fields for %j",
    (model) => {
      expect(toBuiltinBackendSelection(config("antigravity", {
        model,
        command: "native-acp",
        envVars: { GEMINI_HOME: "native-home" },
        reasoningEffort: "low",
        provider: { kind: "custom", apiUrl: "https://example.invalid", apiKey: "foreign-provider" },
      }))).toEqual({
        backend: "antigravity",
        config: { model, command: "native-acp", environment: { GEMINI_HOME: "native-home" }, reasoningEffort: "low" },
      });
    },
  );
});
