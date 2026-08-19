import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { buildClaudeProviderIsolationEnv } from "./providerIsolation.js";

describe("buildClaudeProviderIsolationEnv", () => {
  it("does not isolate a default provider", () => {
    const ctx = fakeLaunchContext("claude", process.cwd(), {
      config: { runtimeConfig: { model: { kind: "default" }, provider: { kind: "default" }, mode: "default" } },
    });
    expect(buildClaudeProviderIsolationEnv(ctx)).toEqual({});
  });

  it("creates a workspace-local home for a custom provider", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "claude-provider-isolation-"));
    try {
      const ctx = fakeLaunchContext("claude", workingDirectory, {
        config: {
          runtimeConfig: {
            model: { kind: "default" },
            provider: { kind: "custom_endpoint", apiUrl: "https://example.invalid", apiKey: "test-key" },
            mode: "default",
          },
        },
      });
      const env = buildClaudeProviderIsolationEnv(ctx);
      expect(env.HOME).toBe(join(workingDirectory, ".alook", "claude-provider", "home"));
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME!, ".claude"));
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
      expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(true);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
