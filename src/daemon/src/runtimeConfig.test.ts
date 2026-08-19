import { describe, it, expect } from "vitest";
import { resolveLaunchFields } from "./runtimeConfig";
import { makeRuntimeConfig } from "./runtimeConfig";

describe("resolveLaunchFields — model id resolution across runtimes", () => {
  for (const runtime of ["claude", "codex", "cursor", "opencode", "pi"]) {
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
    const f = resolveLaunchFields(makeRuntimeConfig({ runtime: "cursor" }));
    expect(f.model).toBeUndefined();
  });
});
