import { describe, it, expect } from "vitest";
import { buildGeminiArgs, GeminiDriver } from "./gemini";
import { makeRuntimeConfig } from "../runtimeConfig";
import type { LaunchConfig } from "../types";

describe("GeminiDriver", () => {
  it("declares detectedModelsVerifiedAs 'launchable' (its --model flag actually launches)", () => {
    const driver = new GeminiDriver();
    expect(driver.model.detectedModelsVerifiedAs).toBe("launchable");
  });
});

describe("buildGeminiArgs — model flag is conditional on f.model", () => {
  it("omits --model when the runtime config leaves it default", () => {
    const config: LaunchConfig = { runtimeConfig: makeRuntimeConfig({ runtime: "gemini" }) };
    const args = buildGeminiArgs(config);
    expect(args).not.toContain("--model");
  });

  it("pushes --model <name> when a named model is set", () => {
    const config: LaunchConfig = {
      runtimeConfig: makeRuntimeConfig({ runtime: "gemini", model: { kind: "named", name: "gemini-2.5-pro" } }),
    };
    const args = buildGeminiArgs(config);
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gemini-2.5-pro");
  });
});
