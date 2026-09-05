import { describe, expect, it } from "vitest";
import {
  nativeOauthCallbackUrls,
  nativeOauthExchangeSchema,
  nativeOauthJson,
  nativeOauthRegistrationSchema,
  nativeOauthReturnUrl,
  parseNativeOauthJson,
  pkceChallenge,
  sanitizeOauthFailure,
  sha256Hex,
} from "./native-oauth";

const ATTEMPT = "attempt_1234567890123456";
const STATE = "A".repeat(43);
const VERIFIER = "B".repeat(43);

function jsonRequest(body: unknown, origin = "https://alook.ai") {
  return new Request("https://alook.ai/api/auth/native/attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

describe("native OAuth protocol helpers", () => {
  it("accepts the exact registration shape and rejects unknown fields", () => {
    const value = {
      attemptId: ATTEMPT,
      stateHash: "a".repeat(64),
      codeChallenge: "C".repeat(43),
      instanceKeyHash: "b".repeat(64),
      platform: "ios",
      provider: "github",
      redirectPath: "/c/me?from=native",
    };
    expect(nativeOauthRegistrationSchema.safeParse(value).success).toBe(true);
    expect(nativeOauthRegistrationSchema.safeParse({ ...value, state: STATE }).success).toBe(false);
  });

  it("requires same-origin JSON and bounds the request body", async () => {
    const invalidOrigin = await parseNativeOauthJson(
      jsonRequest({}, "https://evil.example"),
      "https://alook.ai",
      nativeOauthRegistrationSchema,
    );
    expect(invalidOrigin.ok).toBe(false);
    if (!invalidOrigin.ok) expect(invalidOrigin.response.status).toBe(403);

    const alternateHost = new Request("https://preview.example/api/auth/native/attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://alook.ai" },
      body: "{}",
    });
    const alternateHostResult = await parseNativeOauthJson(
      alternateHost,
      "https://alook.ai",
      nativeOauthRegistrationSchema,
    );
    expect(alternateHostResult.ok).toBe(false);
    if (!alternateHostResult.ok) {
      expect(alternateHostResult.response.status).toBe(403);
    }

    const oversized = jsonRequest({ padding: "x".repeat(5000) });
    const parsed = await parseNativeOauthJson(
      oversized,
      "https://alook.ai",
      nativeOauthRegistrationSchema,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
  });

  it("accepts only the exact preserved Host through a loopback reverse proxy", async () => {
    const body = {
      attemptId: ATTEMPT,
      stateHash: "a".repeat(64),
      codeChallenge: "C".repeat(43),
      instanceKeyHash: "b".repeat(64),
      platform: "ios",
      provider: "github",
      redirectPath: "/c/me",
    };
    const request = (host: string, internalUrl = "http://127.0.0.1:3001") =>
      new Request(`${internalUrl}/api/auth/native/attempt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: host,
          Origin: "http://localhost:3000",
          "X-Forwarded-Host": "localhost:3000",
        },
        body: JSON.stringify(body),
      });

    const accepted = await parseNativeOauthJson(
      request("localhost:3000"),
      "http://localhost:3000",
      nativeOauthRegistrationSchema,
    );
    expect(accepted).toEqual({ ok: true, data: body });

    for (const rejectedRequest of [
      request("evil.example"),
      request("localhost:3000", "http://internal.example"),
    ]) {
      const rejected = await parseNativeOauthJson(
        rejectedRequest,
        "http://localhost:3000",
        nativeOauthRegistrationSchema,
      );
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.response.status).toBe(403);
    }

    const publicTarget = await parseNativeOauthJson(
      new Request("http://127.0.0.1:3001/api/auth/native/attempt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "alook.ai",
          Origin: "https://alook.ai",
        },
        body: JSON.stringify(body),
      }),
      "https://alook.ai",
      nativeOauthRegistrationSchema,
    );
    expect(publicTarget.ok).toBe(false);
    if (!publicTarget.ok) expect(publicTarget.response.status).toBe(403);
  });

  it("derives SHA-256 and RFC 7636 S256 values", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("keeps raw state and verifier out of every callback/return URL", () => {
    const callbacks = nativeOauthCallbackUrls("https://alook.ai", ATTEMPT);
    const mobile = nativeOauthReturnUrl("ios", ATTEMPT, { code: "z".repeat(32) });
    const desktop = nativeOauthReturnUrl("linux", ATTEMPT, { status: "access_denied" });

    expect(callbacks).toEqual({
      callbackURL: `https://alook.ai/auth/native/callback?attempt=${ATTEMPT}&kind=signin`,
      newUserCallbackURL: `https://alook.ai/auth/native/callback?attempt=${ATTEMPT}&kind=signup`,
      errorCallbackURL: `https://alook.ai/auth/native/callback?attempt=${ATTEMPT}&kind=error`,
    });
    expect(mobile).toBe(
      `https://auth.alook.ai/auth/native/return?attempt=${ATTEMPT}&code=${"z".repeat(32)}`,
    );
    expect(desktop).toBe(
      `ai.alook.desktop://auth/native/return?attempt=${ATTEMPT}&status=access_denied`,
    );
    for (const url of [...Object.values(callbacks), mobile, desktop]) {
      expect(url).not.toContain(STATE);
      expect(url).not.toContain(VERIFIER);
    }
  });

  it("accepts only a bounded exchange body and sanitizes provider errors", () => {
    expect(nativeOauthExchangeSchema.safeParse({
      attemptId: ATTEMPT,
      state: STATE,
      verifier: VERIFIER,
      code: "c".repeat(32),
    }).success).toBe(true);
    expect(sanitizeOauthFailure("access_denied")).toBe("access_denied");
    expect(sanitizeOauthFailure("invalid_code")).toBe("provider_error");
    expect(sanitizeOauthFailure("provider-secret-detail")).toBe("oauth_callback_failed");
  });

  it("sets no-store/no-referrer on protocol JSON", () => {
    const response = nativeOauthJson({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
