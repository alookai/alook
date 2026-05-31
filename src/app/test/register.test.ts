import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@alook/shared", () => ({ DEV_PASSWORD: "dev-pw" }));
vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: "/tmp/alook-test" }));

import {
  registerUser,
  createWorkspace,
  createMachineToken,
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

afterEach(() => vi.restoreAllMocks());

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

describe("createWorkspace", () => {
  it("returns the created workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ id: "w1", name: "Personal", slug: "personal" }),
    } as unknown as Response));
    const ws = await createWorkspace(BASE, "cookie");
    expect(ws.id).toBe("w1");
  });

  it("falls back to the first existing workspace when creation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, headers: new Headers() } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => [{ id: "w-existing", name: "Old", slug: "old" }] } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const ws = await createWorkspace(BASE, "cookie");
    expect(ws.id).toBe("w-existing");
  });
});

describe("createMachineToken", () => {
  it("returns the token payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), json: async () => ({ token: "al_x", id: "mt1" }),
    } as unknown as Response));
    const tok = await createMachineToken(BASE, "cookie", "w1");
    expect(tok.token).toBe("al_x");
  });

  it("exits when token creation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "no", headers: new Headers() } as unknown as Response));
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    await expect(createMachineToken(BASE, "cookie", "w1")).rejects.toThrow("exit");
  });
});

describe("waitForServer", () => {
  it("returns once the server responds below 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 } as unknown as Response));
    await expect(waitForServer(BASE, 5000)).resolves.toBeUndefined();
  });

  it("exits when the server never comes up before the deadline", async () => {
    // A non-positive timeout makes the deadline already-past, so the poll loop is
    // skipped and the not-started exit(1) path runs — no timer plumbing needed.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    await expect(waitForServer(BASE, 0)).rejects.toThrow("exit");
  });
});
