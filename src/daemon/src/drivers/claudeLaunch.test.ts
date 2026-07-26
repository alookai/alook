import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "./claudeLaunch";
import { makeRuntimeConfig } from "../runtimeConfig";
import type { LaunchConfig } from "../types";

/**
 * Consistent-drivers plan: Claude no longer hard-codes `--model sonnet` when
 * the caller didn't pick one. `{kind:"default"}` finally means "let the CLI
 * decide" across every driver, matching every non-claude driver's behavior.
 */
describe("buildClaudeArgs — model flag is conditional", () => {
  it("omits --model when runtimeConfig.model.kind === 'default'", () => {
    const config: LaunchConfig = { runtimeConfig: makeRuntimeConfig({ runtime: "claude" }) };
    const args = buildClaudeArgs(config);
    expect(args).not.toContain("--model");
  });

  it("emits --model <name> when a named model is set", () => {
    const config: LaunchConfig = {
      runtimeConfig: makeRuntimeConfig({ runtime: "claude", model: { kind: "named", name: "opus" } }),
    };
    const args = buildClaudeArgs(config);
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("opus");
  });

  it("passes --resume <sessionId> when resuming", () => {
    const config: LaunchConfig = {
      sessionId: "sess-42",
      runtimeConfig: makeRuntimeConfig({ runtime: "claude" }),
    };
    const args = buildClaudeArgs(config);
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("sess-42");
  });
});
