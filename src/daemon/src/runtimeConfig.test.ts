import { describe, it, expect } from "vitest";
import { resolveLaunchFields } from "./runtimeConfig";
import { makeRuntimeConfig } from "./runtimeConfig";
import { buildAntigravityArgs } from "./drivers/antigravity";
import type { LaunchContext } from "./types";

describe("resolveLaunchFields — model id resolution across runtimes", () => {
  for (const runtime of ["claude", "codex", "gemini", "kimi"]) {
    it(`${runtime}: {kind:"named",name:"opus"} → f.model === "opus"`, () => {
      const f = resolveLaunchFields(makeRuntimeConfig({ runtime, model: { kind: "named", name: "opus" } }));
      expect(f.model).toBe("opus");
    });
  }

  it("claude: a custom model additionally sets ANTHROPIC_CUSTOM_MODEL_OPTION", () => {
    const f = resolveLaunchFields(makeRuntimeConfig({ runtime: "claude", model: { kind: "custom", name: "my-ft" } }));
    expect(f.model).toBe("my-ft");
    expect(f.providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe("my-ft");
  });

  it("codex: a custom model does NOT set the claude-specific env", () => {
    const f = resolveLaunchFields(makeRuntimeConfig({ runtime: "codex", model: { kind: "custom", name: "my-ft" } }));
    expect(f.model).toBe("my-ft");
    expect(f.providerEnv.ANTHROPIC_CUSTOM_MODEL_OPTION).toBeUndefined();
  });

  it("default model → f.model is undefined", () => {
    const f = resolveLaunchFields(makeRuntimeConfig({ runtime: "gemini" }));
    expect(f.model).toBeUndefined();
  });
});

describe("antigravity — discards the model at launch", () => {
  it("buildAntigravityArgs emits no model arg even when a model is set", () => {
    const ctx = {
      workingDirectory: "/tmp",
      agentId: "a1",
      standingPrompt: "",
      prompt: "hi",
      config: { runtimeConfig: makeRuntimeConfig({ runtime: "antigravity", model: { kind: "named", name: "opus" } }) },
    } as unknown as LaunchContext;
    const args = buildAntigravityArgs(ctx);
    expect(args).not.toContain("--model");
    expect(args.join(" ")).not.toContain("opus");
  });
});
