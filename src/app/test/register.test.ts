import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "http";

vi.mock("@alook/shared", () => ({ DEV_PASSWORD: "dev-pw" }));
vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: "/tmp/alook-test" }));

import {
  registerUser,
  createPairingToken,
  waitForServer,
} from "../src/lib/register.js";

const BASE = "http://localhost:3000";

/** Build a fetch Response with a Set-Cookie session header. */
function sessionResponse(ok = true, status = 200) {
  const headers = new Headers();
  // jsdom-less node Headers supports getSetCookie via append
  headers.append("set-cookie", "better-auth.session_token=abc; Path=/");
  return {
    ok,
    status,
    headers,
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Make console quiet and prevent process.exit from killing the test runner.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registerUser", () => {
  it("returns a session cookie on successful signup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse()));
    const result = await registerUser(BASE, "x@t.com");
    expect(result.sessionCookie).toContain("better-auth.session_token");
  });

  it("falls back to sign-in when the account already exists", async () => {
    const fetchMock = vi
      .fn()
      // signup fails with "already exists"
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "User already exists", headers: new Headers() } as unknown as Response)
      // sign-in succeeds with a session cookie
      .mockResolvedValueOnce(sessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerUser(BASE, "x@t.com");
    expect(result.sessionCookie).toContain("better-auth.session_token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain("/api/auth/sign-in/email");
  });

  it("exits when signup fails for a non-conflict reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom", headers: new Headers() } as unknown as Response));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    await expect(registerUser(BASE, "x@t.com")).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("createPairingToken", () => {
  it("creates a community pairing token with the authenticated session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ tokenId: "cmt_pair", expiresAt: "2026-08-14T02:00:00Z" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const result = await createPairingToken(BASE, "session-cookie");
    expect(result.tokenId).toBe("cmt_pair");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/community/machines/pair`, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Cookie: "session-cookie", Origin: BASE }),
    }));
  });

  it("rejects an invalid pairing response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ tokenId: "al_legacy" }),
    } as unknown as Response));
    await expect(createPairingToken(BASE, "cookie")).rejects.toThrow("invalid token");
  });

  it("surfaces pairing failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "no", headers: new Headers() } as unknown as Response));
    await expect(createPairingToken(BASE, "cookie")).rejects.toThrow("pairing token (500)");
  });
});

describe("waitForServer", () => {
  it("returns once the server responds below 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 } as unknown as Response));
    await expect(waitForServer(BASE, 5000)).resolves.toBeUndefined();
  });

  it("rejects when the server never comes up before the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(waitForServer(BASE, 0)).rejects.toThrow("server did not start within 1 seconds");
  });

  it("enforces the deadline when a listener accepts HTTP but never responds", async () => {
    vi.unstubAllGlobals();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener address");

    const startedAt = Date.now();
    try {
      await expect(waitForServer(`http://127.0.0.1:${address.port}`, 100)).rejects.toThrow(
        "server did not start within 1 seconds",
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
