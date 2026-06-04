import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetLatestTokenForUser = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => Promise.resolve({ env: { DB: {} } })),
}));
vi.mock("@alook/shared", () => ({
  queries: {
    machineToken: {
      getLatestTokenForUser: (...args: any[]) => mockGetLatestTokenForUser(...args),
    },
  },
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: any) => handler(req, { userId: "u1", email: "test@test.com" }),
}));

import { GET } from "./route";

describe("GET /api/machine-tokens/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null status when no token exists", async () => {
    mockGetLatestTokenForUser.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBeNull();
  });

  it("returns pending status", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "pending", workspaceId: null, hostname: null,
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("pending");
    expect(body.workspace_id).toBeUndefined();
    expect(body.hostname).toBeUndefined();
  });

  it("returns registered status with hostname", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "registered", workspaceId: null, hostname: "MacBook.local",
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("registered");
    expect(body.hostname).toBe("MacBook.local");
    expect(body.workspace_id).toBeUndefined();
  });

  it("returns active status with workspace_id and hostname", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "active", workspaceId: "sp_ws1", hostname: "MacBook.local", lastUsedAt: null,
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("active");
    expect(body.workspace_id).toBe("sp_ws1");
    expect(body.hostname).toBe("MacBook.local");
    expect(body.daemon_online).toBe(false);
  });

  it("returns daemon_online true when lastUsedAt is recent", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "registered", workspaceId: null, hostname: "MacBook.local",
      lastUsedAt: new Date(Date.now() - 30_000).toISOString(),
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.daemon_online).toBe(true);
  });

  it("returns daemon_online false when lastUsedAt is stale", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "registered", workspaceId: null, hostname: "MacBook.local",
      lastUsedAt: new Date(Date.now() - 300_000).toISOString(),
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.daemon_online).toBe(false);
  });

  it("does NOT return runtimes when token is already bound to a workspace", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "active", workspaceId: "sp_ws1", hostname: "MacBook.local",
      lastUsedAt: new Date(Date.now() - 30_000).toISOString(),
      runtimesJson: '[{"type":"claude","version":"4.0"}]',
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("active");
    expect(body.workspace_id).toBe("sp_ws1");
    expect(body.runtimes).toBeUndefined();
  });

  it("returns runtimes when token is NOT bound to a workspace", async () => {
    mockGetLatestTokenForUser.mockResolvedValue({
      id: "mt_1", status: "registered", workspaceId: null, hostname: "MacBook.local",
      lastUsedAt: new Date(Date.now() - 30_000).toISOString(),
      runtimesJson: '[{"type":"claude","version":"4.0"}]',
    });

    const req = new NextRequest("http://localhost/api/machine-tokens/status");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("registered");
    expect(body.workspace_id).toBeUndefined();
    expect(body.runtimes).toBeDefined();
    expect(body.runtimes).toHaveLength(1);
    expect(body.runtimes[0].type).toBe("claude");
  });

});
