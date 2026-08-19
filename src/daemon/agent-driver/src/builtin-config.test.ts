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
  });

  it.each(["codex", "cursor", "opencode", "pi"])("maps %s without daemon-side switches", (runtime) => {
    expect(toBuiltinBackendSelection(config(runtime))).toMatchObject({ backend: runtime });
  });

  it("rejects unknown runtime ids", () => {
    expect(() => toBuiltinBackendSelection(config("unknown"))).toThrow("Unknown runtime: unknown");
  });
});
