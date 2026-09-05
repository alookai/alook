import { beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge, sha256Hex } from "@/lib/native-oauth";

const BASE_URL = "https://app.alook.ai";
const ATTEMPT = "attempt_1234567890123456";
const STATE = "s".repeat(43);
const VERIFIER = "v".repeat(43);
const CODE = "c".repeat(32);

const queryMocks = {
  registerAttempt: vi.fn(),
  claimStart: vi.fn(),
  getOpenedAttempt: vi.fn(),
  attachHandoff: vi.fn(),
  failOpenedAttempt: vi.fn(),
  claimExchange: vi.fn(),
  finishExchange: vi.fn(),
  failExchange: vi.fn(),
  cancelAttempt: vi.fn(),
  getAttemptStatus: vi.fn(),
};
const authMocks = {
  signInSocial: vi.fn(),
  generateOneTimeToken: vi.fn(),
  verifyOneTimeToken: vi.fn(),
};
const rateLimitMock = vi.fn();
const db = {};
const env = { BETTER_AUTH_URL: BASE_URL, DB: {} };

const attemptRow = {
  id: ATTEMPT,
  provider: "github",
  platform: "ios",
  redirectPath: "/c/me",
  authKind: "signin",
  status: "opened",
  attemptExpiresAt: Date.now() + 60_000,
  failureCode: null,
};

function installMocks() {
  vi.doMock("@/lib/middleware/env", () => ({
    withEnv:
      (route: (request: Request, context: { env: typeof env }) => Promise<Response>) =>
      (request: Request) =>
        route(request, { env }),
  }));
  vi.doMock("@/lib/db", () => ({ getPrimaryDb: () => db }));
  vi.doMock("@/lib/rate-limit", () => ({
    checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
  }));
  vi.doMock("@/lib/auth", () => ({
    createAuth: () => ({ api: authMocks }),
  }));
  vi.doMock("@alook/shared", async () => {
    const actual = await vi.importActual<typeof import("@alook/shared")>(
      "@alook/shared",
    );
    return {
      ...actual,
      createLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
      queries: { ...actual.queries, nativeOauth: queryMocks },
    };
  });
}

function post(path: string, body: unknown, origin = BASE_URL): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });
}

function proof() {
  return { attemptId: ATTEMPT, state: STATE, verifier: VERIFIER };
}

async function loadAttemptRoute() {
  installMocks();
  return (await import("./attempt/route")).POST;
}

async function loadExchangeRoute() {
  installMocks();
  return (await import("./exchange/route")).POST;
}

async function loadStatusRoute() {
  installMocks();
  return (await import("./status/route")).POST;
}

async function loadCancelRoute() {
  installMocks();
  return (await import("./cancel/route")).POST;
}

async function loadStartRoute() {
  installMocks();
  return (await import("../../../auth/native/start/route")).GET;
}

async function loadCallbackRoute() {
  installMocks();
  return (await import("../../../auth/native/callback/route")).GET;
}

describe("native OAuth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(queryMocks)) mock.mockReset();
    for (const mock of Object.values(authMocks)) mock.mockReset();
    rateLimitMock.mockReset();
    rateLimitMock.mockResolvedValue({ allowed: true });
  });

  it("registers a strict same-origin request and returns only the start URL", async () => {
    queryMocks.registerAttempt.mockResolvedValue(attemptRow);
    const route = await loadAttemptRoute();
    const body = {
      attemptId: ATTEMPT,
      stateHash: "a".repeat(64),
      codeChallenge: "p".repeat(43),
      instanceKeyHash: "b".repeat(64),
      platform: "ios",
      provider: "github",
      redirectPath: "/c/me",
    };
    const response = await route(post("/api/auth/native/attempt", body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      startUrl: `${BASE_URL}/auth/native/start?attempt=${ATTEMPT}`,
    });
    expect(queryMocks.registerAttempt).toHaveBeenCalledWith(db, {
      id: ATTEMPT,
      instanceKeyHash: body.instanceKeyHash,
      stateHash: body.stateHash,
      pkceChallenge: body.codeChallenge,
      provider: "github",
      platform: "ios",
      redirectPath: "/c/me",
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("rejects cross-origin registration before rate limit or D1", async () => {
    const route = await loadAttemptRoute();
    const response = await route(
      post("/api/auth/native/attempt", {}, "https://evil.example"),
    );

    expect(response.status).toBe(403);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(queryMocks.registerAttempt).not.toHaveBeenCalled();
  });

  it("rate limits registration by a hashed network key", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSec: 9 });
    const route = await loadAttemptRoute();
    const response = await route(post("/api/auth/native/attempt", {
      attemptId: ATTEMPT,
      stateHash: "a".repeat(64),
      codeChallenge: "p".repeat(43),
      instanceKeyHash: "b".repeat(64),
      platform: "ios",
      provider: "github",
      redirectPath: "/c/me",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
    expect(rateLimitMock).toHaveBeenCalledWith(
      env,
      "auth:nativeAttempt",
      await sha256Hex("203.0.113.7"),
    );
    expect(queryMocks.registerAttempt).not.toHaveBeenCalled();
  });

  it("does not misreport a D1 outage as an attempt collision", async () => {
    queryMocks.registerAttempt.mockRejectedValue(new Error("D1 unavailable"));
    const route = await loadAttemptRoute();
    const response = await route(post("/api/auth/native/attempt", {
      attemptId: ATTEMPT,
      stateHash: "a".repeat(64),
      codeChallenge: "p".repeat(43),
      instanceKeyHash: "b".repeat(64),
      platform: "ios",
      provider: "github",
      redirectPath: "/c/me",
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("starts OAuth once and forwards every Better Auth cookie", async () => {
    queryMocks.claimStart
      .mockResolvedValueOnce(attemptRow)
      .mockResolvedValueOnce(null);
    const authHeaders = new Headers();
    authHeaders.append("Set-Cookie", "oauth_state=one; HttpOnly; Path=/");
    authHeaders.append("Set-Cookie", "oauth_verifier=two; HttpOnly; Path=/");
    authMocks.signInSocial.mockResolvedValue({
      response: { url: "https://github.com/login/oauth/authorize?client_id=x" },
      headers: authHeaders,
    });
    const route = await loadStartRoute();
    const first = await route(
      new Request(`${BASE_URL}/auth/native/start?attempt=${ATTEMPT}`),
    );
    const second = await route(
      new Request(`${BASE_URL}/auth/native/start?attempt=${ATTEMPT}`),
    );

    expect(first.status).toBe(302);
    expect(first.headers.getSetCookie()).toHaveLength(2);
    expect(authMocks.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          provider: "github",
          disableRedirect: true,
          callbackURL: `${BASE_URL}/auth/native/callback?attempt=${ATTEMPT}&kind=signin`,
        }),
      }),
    );
    expect(second.status).toBe(410);
    expect(authMocks.signInSocial).toHaveBeenCalledOnce();
  });

  it("hashes the callback handoff and never exposes it in stored form", async () => {
    queryMocks.getOpenedAttempt.mockResolvedValue(attemptRow);
    queryMocks.attachHandoff.mockImplementation(async (_db, input) => ({
      ...attemptRow,
      ...input,
    }));
    authMocks.generateOneTimeToken.mockResolvedValue({
      response: { token: CODE },
      headers: new Headers(),
    });
    const route = await loadCallbackRoute();
    const response = await route(
      new Request(
        `${BASE_URL}/auth/native/callback?attempt=${ATTEMPT}&kind=signin`,
        { headers: { Cookie: "better-auth.session_token=browser" } },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `https://auth.alook.ai/auth/native/return?attempt=${ATTEMPT}&code=${CODE}`,
    );
    expect(queryMocks.attachHandoff).toHaveBeenCalledWith(db, {
      attemptId: ATTEMPT,
      handoffCodeHash: await sha256Hex(CODE),
      authKind: "signin",
    });
    expect(response.headers.getSetCookie().join(";")).not.toContain(CODE);
  });

  it("sanitizes callback errors before storing or returning them", async () => {
    queryMocks.getOpenedAttempt.mockResolvedValue(attemptRow);
    const route = await loadCallbackRoute();
    const response = await route(
      new Request(
        `${BASE_URL}/auth/native/callback?attempt=${ATTEMPT}&kind=error&error=raw_provider_secret`,
      ),
    );

    expect(queryMocks.failOpenedAttempt).toHaveBeenCalledWith(
      db,
      ATTEMPT,
      "oauth_callback_failed",
    );
    expect(response.headers.get("Location")).toContain(
      "status=oauth_callback_failed",
    );
    expect(response.headers.get("Location")).not.toContain("raw_provider_secret");
  });

  it("does not invoke OTT verification or mutate after a wrong exchange proof", async () => {
    queryMocks.claimExchange.mockResolvedValue(null);
    const route = await loadExchangeRoute();
    const response = await route(
      post("/api/auth/native/exchange", { ...proof(), code: CODE }),
    );

    expect(response.status).toBe(400);
    expect(authMocks.verifyOneTimeToken).not.toHaveBeenCalled();
    expect(queryMocks.finishExchange).not.toHaveBeenCalled();
    expect(queryMocks.failExchange).not.toHaveBeenCalled();
  });

  it("releases Better Auth cookies only after the final consume CAS", async () => {
    const claimed = { ...attemptRow, status: "exchanging" };
    queryMocks.claimExchange.mockResolvedValue(claimed);
    queryMocks.finishExchange.mockResolvedValue({
      ...claimed,
      status: "consumed",
    });
    const headers = new Headers();
    headers.append("Set-Cookie", "better-auth.session_token=webview; HttpOnly; Path=/");
    authMocks.verifyOneTimeToken.mockResolvedValue({ headers, response: {} });
    const route = await loadExchangeRoute();
    const response = await route(
      post("/api/auth/native/exchange", { ...proof(), code: CODE }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectPath: "/c/me" });
    expect(response.headers.getSetCookie().join(";")).toContain(
      "better-auth.session_token=webview",
    );
    expect(response.headers.getSetCookie().join(";")).toContain(
      "is_sign_in=github",
    );
    expect(queryMocks.claimExchange).toHaveBeenCalledWith(db, {
      attemptId: ATTEMPT,
      stateHash: await sha256Hex(STATE),
      pkceChallenge: await pkceChallenge(VERIFIER),
      handoffCodeHash: await sha256Hex(CODE),
    });
  });

  it("drops already-created cookies when cancellation wins the final CAS", async () => {
    queryMocks.claimExchange.mockResolvedValue({
      ...attemptRow,
      status: "exchanging",
    });
    queryMocks.finishExchange.mockResolvedValue(null);
    const headers = new Headers();
    headers.append("Set-Cookie", "better-auth.session_token=must-not-escape");
    authMocks.verifyOneTimeToken.mockResolvedValue({ headers, response: {} });
    const route = await loadExchangeRoute();
    const response = await route(
      post("/api/auth/native/exchange", { ...proof(), code: CODE }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("drops verified cookies when finalization is unavailable", async () => {
    queryMocks.claimExchange.mockResolvedValue({
      ...attemptRow,
      status: "exchanging",
    });
    queryMocks.finishExchange.mockRejectedValue(new Error("D1 unavailable"));
    const headers = new Headers();
    headers.append("Set-Cookie", "better-auth.session_token=must-not-escape");
    authMocks.verifyOneTimeToken.mockResolvedValue({ headers, response: {} });
    const route = await loadExchangeRoute();
    const response = await route(
      post("/api/auth/native/exchange", { ...proof(), code: CODE }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("reports expiration without mutating the attempt", async () => {
    queryMocks.getAttemptStatus.mockResolvedValue({
      ...attemptRow,
      status: "ready",
      attemptExpiresAt: Date.now() - 1,
    });
    const route = await loadStatusRoute();
    const response = await route(
      post("/api/auth/native/status", proof()),
    );

    expect(await response.json()).toEqual({ status: "expired" });
    expect(queryMocks.cancelAttempt).not.toHaveBeenCalled();
  });

  it("keeps a status D1 outage generic and non-cacheable", async () => {
    queryMocks.getAttemptStatus.mockRejectedValue(new Error("D1 unavailable"));
    const route = await loadStatusRoute();
    const response = await route(post("/api/auth/native/status", proof()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("makes stale cancellation a proof-bound no-op", async () => {
    queryMocks.cancelAttempt.mockResolvedValue(null);
    const route = await loadCancelRoute();
    const response = await route(
      post("/api/auth/native/cancel", proof()),
    );

    expect(await response.json()).toEqual({ status: "unchanged" });
    expect(queryMocks.cancelAttempt).toHaveBeenCalledWith(db, {
      attemptId: ATTEMPT,
      stateHash: await sha256Hex(STATE),
      pkceChallenge: await pkceChallenge(VERIFIER),
    });
  });
});
