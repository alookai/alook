import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    machineToken: {
      getMachineTokenByToken: vi.fn(),
      updateMachineTokenLastUsed: vi.fn(),
    },
  },
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: mockGetSession },
  })),
}));

import { withAuth, warmMachineTokenCache } from "./auth";
import { queries } from "@alook/shared";

const mockGetMachineTokenByHash = queries.machineToken
  .getMachineTokenByToken as ReturnType<typeof vi.fn>;
const mockUpdateMachineTokenLastUsed = queries.machineToken
  .updateMachineTokenLastUsed as ReturnType<typeof vi.fn>;
const mockGetCloudflareContext = getCloudflareContext as unknown as ReturnType<typeof vi.fn>;

/** Build a stub KV and point the CF context at it for one test. */
function bindMockKV(overrides?: { get?: ReturnType<typeof vi.fn> }) {
  const kv = {
    get: overrides?.get ?? vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  mockGetCloudflareContext.mockResolvedValue({ env: { DB: {}, CACHE_KV: kv } });
  return kv;
}

const testHandler = vi.fn(async (_req: NextRequest, ctx: any) =>
  NextResponse.json({ ok: true, ctx })
);

describe("withAuth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no KV bound (cold-path every request), matching original tests.
    mockGetCloudflareContext.mockResolvedValue({ env: { DB: {} } });
  });

  const wrapped = withAuth(testHandler);

  it("returns 401 when Authorization header is missing", async () => {
    const req = new NextRequest("http://localhost/api/test");
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when Authorization format is not Bearer", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Basic abc123" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when Authorization has no token after Bearer", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer " },
    });

    mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });

    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("authenticates valid Better Auth session and passes userId/email to handler", async () => {
    mockGetSession.mockResolvedValue({
      headers: new Headers(),
      response: { user: { id: "user-1", email: "user@example.com" } },
    });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-session-token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ctx.userId).toBe("user-1");
    expect(body.ctx.email).toBe("user@example.com");
    expect(testHandler).toHaveBeenCalledOnce();
  });

  it("returns 401 when Better Auth session is null", async () => {
    mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-session-token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("authenticates machine token (al_ prefix) via hash lookup", async () => {
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-1",
      userId: "user-mt",
      userEmail: "mt@example.com",
      workspaceId: "ws-1",
    });
    mockUpdateMachineTokenLastUsed.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_secret_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ctx.userId).toBe("user-mt");
    expect(body.ctx.email).toBe("mt@example.com");
    expect(body.ctx.workspaceId).toBe("ws-1");
    expect(mockGetMachineTokenByHash).toHaveBeenCalledOnce();
  });

  it("returns 401 for unknown machine token (getMachineTokenByToken returns null)", async () => {
    mockGetMachineTokenByHash.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_invalid_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid token");
  });

  it("returns 503 (not 401) when the D1 token lookup throws — transient, daemon must retry", async () => {
    mockGetMachineTokenByHash.mockRejectedValue(new Error("D1 unavailable"));

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_valid_but_db_down" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    // Must NOT be 401 — a DB blip is not a revoked token; the daemon uses 401
    // to mark a workspace auth-failed, so a transient failure must be 503.
    expect(res.status).toBe(503);
    expect(body.error).not.toBe("invalid token");
  });

  it("updates lastUsedAt on machine token auth", async () => {
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-2",
      userId: "user-mt2",
      userEmail: "mt2@example.com",
      workspaceId: null,
    });
    mockUpdateMachineTokenLastUsed.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_another_token" },
    });
    await wrapped(req);

    expect(mockUpdateMachineTokenLastUsed).toHaveBeenCalledWith({}, "mt-2");
  });

  it("cold KV miss populates the merged entry and bumps last_used immediately", async () => {
    const kv = bindMockKV();
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-cold",
      userId: "user-cold",
      userEmail: "cold@example.com",
      workspaceId: null,
    });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_cold_token" },
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(mockGetMachineTokenByHash).toHaveBeenCalledOnce();
    expect(mockUpdateMachineTokenLastUsed).toHaveBeenCalledWith({}, "mt-cold");
    // Entry written back with luAt so the throttle window starts now.
    expect(kv.put).toHaveBeenCalledOnce();
    const [, storedJson] = kv.put.mock.calls[0];
    const stored = JSON.parse(storedJson);
    expect(stored.row.id).toBe("mt-cold");
    expect(typeof stored.luAt).toBe("number");
  });

  it("warm KV hit within throttle window skips D1 and does not bump", async () => {
    const entry = {
      row: { id: "mt-warm", userId: "user-warm", userEmail: "warm@example.com", workspaceId: "ws-w" },
      luAt: Date.now(),
    };
    bindMockKV({ get: vi.fn().mockResolvedValue(JSON.stringify(entry)) });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_warm_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ctx.userId).toBe("user-warm");
    expect(mockGetMachineTokenByHash).not.toHaveBeenCalled();
    expect(mockUpdateMachineTokenLastUsed).not.toHaveBeenCalled();
  });

  it("warm KV hit past throttle window bumps last_used and refreshes luAt", async () => {
    const stale = {
      row: { id: "mt-stale", userId: "user-stale", userEmail: "stale@example.com", workspaceId: null },
      luAt: Date.now() - 901_000,
    };
    const kv = bindMockKV({ get: vi.fn().mockResolvedValue(JSON.stringify(stale)) });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_stale_token" },
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(mockGetMachineTokenByHash).not.toHaveBeenCalled();
    expect(mockUpdateMachineTokenLastUsed).toHaveBeenCalledWith({}, "mt-stale");
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it("negative-caches an invalid token so a repeat request skips D1", async () => {
    bindMockKV({ get: vi.fn().mockResolvedValue(JSON.stringify({ row: null, luAt: Date.now() })) });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_negcached_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid token");
    expect(mockGetMachineTokenByHash).not.toHaveBeenCalled();
  });

  it("falls back to D1 when KV read throws (a blip must not 401 a valid token)", async () => {
    bindMockKV({ get: vi.fn().mockRejectedValue(new Error("kv down")) });
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-blip",
      userId: "user-blip",
      userEmail: "blip@example.com",
      workspaceId: null,
    });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_blip_token" },
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(mockGetMachineTokenByHash).toHaveBeenCalledOnce();
  });

  it("resolves dynamic params from context", async () => {
    mockGetSession.mockResolvedValue({
      headers: new Headers(),
      response: { user: { id: "user-p", email: "p@example.com" } },
    });

    const req = new NextRequest("http://localhost/api/test");
    const res = await wrapped(req, {
      params: Promise.resolve({ id: "x" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ctx.params).toEqual({ id: "x" });
  });
});

describe("warmMachineTokenCache", () => {
  beforeEach(() => vi.clearAllMocks());

  const row = {
    id: "mt-warm",
    userId: "user-warm",
    userEmail: "warm@example.com",
    workspaceId: "ws-w",
    status: "active",
  } as any;

  it("writes a positive { row, luAt } entry at the 15-min TTL", async () => {
    const kv = { get: vi.fn(), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn() };
    await warmMachineTokenCache(kv as any, "al_warm_token", row);

    expect(kv.put).toHaveBeenCalledOnce();
    const [key, value, opts] = kv.put.mock.calls[0];
    expect(key).toBe(`mt:${"al_warm_token".slice(0, 20)}`);
    const parsed = JSON.parse(value);
    expect(parsed.row).toEqual(row);
    expect(typeof parsed.luAt).toBe("number");
    expect(opts.expirationTtl).toBe(900);
  });

  it("a subsequent withAuth read hits the warmed entry without touching D1", async () => {
    const entry = { row, luAt: Date.now() };
    bindMockKV({ get: vi.fn().mockResolvedValue(JSON.stringify(entry)) });
    const wrapped = withAuth(testHandler);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_warm_token" },
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    // Warm hit — no cold D1 read.
    expect(mockGetMachineTokenByHash).not.toHaveBeenCalled();
  });

  it("is a no-op when KV is null (no throw)", async () => {
    await expect(warmMachineTokenCache(null, "al_x", row)).resolves.toBeUndefined();
  });
});
