import { describe, expect, it } from "vitest";
import { resolveLaunchFieldsOrDefault } from "./config.js";

describe("resolveLaunchFieldsOrDefault", () => {
  it("resolves Claude custom model/provider fields and strips controlled user env", () => {
    const fields = resolveLaunchFieldsOrDefault({
      model: { kind: "custom", name: "custom-model" },
      provider: { kind: "custom_endpoint", apiUrl: "https://example.invalid", apiKey: "secret" },
      mode: "fast",
      environment: { SAFE: "yes", ANTHROPIC_API_KEY: "ignored" },
    });
    expect(fields).toMatchObject({
      model: "custom-model",
      fastMode: true,
      envVars: { SAFE: "yes" },
      providerEnv: {
        ANTHROPIC_CUSTOM_MODEL_OPTION: "custom-model",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_API_KEY: "secret",
      },
    });
  });

  it("maps known Pi providers and ignores unknown provider ids", () => {
    expect(resolveLaunchFieldsOrDefault({
      model: { kind: "default" },
      provider: { kind: "builtin", providerId: "google", apiKey: "pi-key" },
    }).providerEnv).toEqual({ GEMINI_API_KEY: "pi-key" });
    expect(resolveLaunchFieldsOrDefault({
      model: { kind: "default" },
      provider: { kind: "builtin", providerId: "unknown", apiKey: "pi-key" },
    }).providerEnv).toEqual({});
  });

  it("keeps non-Claude custom models free of Claude provider environment", () => {
    expect(resolveLaunchFieldsOrDefault({
      model: { kind: "custom", name: "custom-codex-model" },
      mode: "default",
    })).toMatchObject({
      model: "custom-codex-model",
      providerEnv: {},
    });
  });
});
