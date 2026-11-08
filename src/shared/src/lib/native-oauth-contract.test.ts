import { describe, expect, it } from "vitest";
import { nativeOauthFailureCodeSchema, nativeOauthPlatformSchema, nativeOauthProviderSchema, nativeOauthRegistrationSchema, nativeOauthExchangeSchema, nativeOauthProofSchema } from "./native-oauth-contract";

describe("native OAuth wire contract", () => {
  it("accepts only the supported providers, platforms and callback failures", () => {
    expect(nativeOauthProviderSchema.options).toEqual(["github", "google", "apple"]);
    expect(nativeOauthPlatformSchema.options).toEqual(["macos", "windows", "linux", "ios", "android"]);
    expect(nativeOauthFailureCodeSchema.options).toEqual(["access_denied", "provider_error", "oauth_callback_failed", "start_failed", "invalid_handoff"]);
    for (const schema of [nativeOauthProviderSchema, nativeOauthPlatformSchema, nativeOauthFailureCodeSchema]) expect(schema.safeParse("unknown").success).toBe(false);
  });
  it("parses registration and proof boundaries and rejects extra fields", () => {
    const registration = { attemptId: "a".repeat(22), stateHash: "a".repeat(64), codeChallenge: "b".repeat(43), instanceKeyHash: "c".repeat(64), platform: "ios", provider: "apple", redirectPath: "/c/me" };
    expect(nativeOauthRegistrationSchema.parse(registration)).toEqual(registration);
    for (const extra of [{ provider: "unknown" }, { platform: "unknown" }, { extra: true }, { redirectPath: "https://outside.test" }]) expect(nativeOauthRegistrationSchema.safeParse({ ...registration, ...extra }).success).toBe(false);
    const proof = { attemptId: registration.attemptId, state: "s".repeat(43), verifier: "v".repeat(43) };
    expect(nativeOauthProofSchema.parse(proof)).toEqual(proof);
    expect(nativeOauthExchangeSchema.parse({ ...proof, code: "x".repeat(32) }).code).toBe("x".repeat(32));
    expect(nativeOauthProofSchema.safeParse({ ...proof, code: "x".repeat(32) }).success).toBe(false);
  });
});
