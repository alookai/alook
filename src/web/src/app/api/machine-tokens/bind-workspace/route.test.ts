import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetRegisteredTokenForUser = vi.fn();
const mockGetLatestTokenForUser = vi.fn();
const mockActivateMachineToken = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();
const mockUpsertMachine = vi.fn();
const mockUpsertAgentRuntime = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockBroadcastToDaemon = vi.fn();
const mockInvalidate = vi.fn(() => Promise.resolve());

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => Promise.resolve({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        machineToken: {
          getRegisteredTokenForUser: (...a: any[]) => mockGetRegisteredTokenForUser(...a),
          getLatestTokenForUser: (...a: any[]) => mockGetLatestTokenForUser(...a),
          activateMachineToken: (...a: any[]) => mockActivateMachineToken(...a),
        },
        member: {
          getMemberByUserAndWorkspace: (...a: any[]) => mockGetMemberByUserAndWorkspace(...a),
        },
        machine: {
          upsertMachine: (...a: any[]) => mockUpsertMachine(...a),
        },
        runtime: {
          upsertAgentRuntime: (...a: any[]) => mockUpsertAgentRuntime(...a),
        },
        workspace: {
          getWorkspace: vi.fn(() => Promise.resolve({ id: "sp_ws1", name: "Test Workspace" })),
        },
      },
      BindWorkspaceRequestSchema: (await import("@alook/shared")).BindWorkspaceRequestSchema,
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
      broadcastToDaemon: (...a: any[]) => mockBroadcastToDaemon(...a),
    },
    "@/lib/cache": {
      invalidate: (...a: any[]) => mockInvalidate(...a),
      cacheKeys: {
        machineToken: (t: string) => `mt:${t}`,
        runtimeIds: (w: string, d: string) => `rt:${w}:${d}`,
        allRuntimes: (w: string) => `runtimes:${w}`,
      },
    },
    "@/lib/api/responses": {
      runtimeToResponse: (rt: any) => ({ id: rt.id, provider: rt.provider }),
    },
  };
}

function makeReq(body: unknown, userId = "u1") {
  const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  // Auth context is injected by withAuth — we mock it via the module
  return { req, userId };
}

describe("POST /api/machine-tokens/bind-workspace", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadRoute() {
    vi.resetModules();

    const mocks = sharedMocks();

    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({
      getDb: vi.fn(() => ({})),
      withD1Retry: (fn: () => any) => fn(),
    }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/cache", () => mocks["@/lib/cache"]);
    vi.doMock("@/lib/api/responses", () => mocks["@/lib/api/responses"]);
    vi.doMock("@/lib/middleware/helpers", async () => {
      return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      );
    });
    vi.doMock("@/lib/middleware/auth", () => ({
      withAuth: (handler: any) => (req: any) => handler(req, { userId: "u1", email: "test@test.com" }),
    }));

    const { POST } = await import("./route");
    return POST;
  }

  const registeredToken = {
    id: "mt_1",
    userId: "u1",
    token: "al_test123",
    hostname: "TestMachine.local",
    runtimesJson: JSON.stringify([{ type: "claude", version: "2.1.0" }]),
    status: "registered",
  };

  it("binds workspace and creates machine/runtime rows", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(registeredToken);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "mem_1" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockBroadcastToDaemon.mockResolvedValue({ sent: 1 });

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("sp_ws1");
    expect(body.runtimes).toHaveLength(1);

    expect(mockActivateMachineToken).toHaveBeenCalledWith(
      expect.anything(),
      "mt_1",
      "sp_ws1",
    );

    expect(mockUpsertMachine).toHaveBeenCalledWith(expect.anything(), {
      daemonId: "TestMachine.local",
      workspaceId: "sp_ws1",
      deviceInfo: "TestMachine.local",
      lastSeenAt: null,
    });

    expect(mockBroadcastToDaemon).toHaveBeenCalledWith("TestMachine.local", {
      type: "daemon.workspace_added",
      workspaceId: "sp_ws1",
      workspaceName: "Test Workspace",
      token: "al_test123",
    });
  });

  it("returns 404 when no registered token", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("no registered token found");
  });

  it("returns 403 when user is not workspace member", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(registeredToken);
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("not a member of this workspace");
  });

  it("returns 409 when token exists but status is not registered (pending)", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(null);
    mockGetLatestTokenForUser.mockResolvedValue({ id: "mt_1", status: "pending" });

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("pending");
    expect(body.error).toContain("expected \"registered\"");
  });

  it("returns 409 when token exists but status is active", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(null);
    mockGetLatestTokenForUser.mockResolvedValue({ id: "mt_1", status: "active" });

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("active");
    expect(body.error).toContain("expected \"registered\"");
  });

  it("returns 404 when no tokens exist at all", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(null);
    mockGetLatestTokenForUser.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("no registered token found");
  });

  it("returns 400 for invalid request body", async () => {
    const POST = await loadRoute();

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing workspace_id", async () => {
    const POST = await loadRoute();

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("succeeds even when broadcast throws (fire-and-forget)", async () => {
    const POST = await loadRoute();

    mockGetRegisteredTokenForUser.mockResolvedValue(registeredToken);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "mem_1" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockBroadcastToUser.mockRejectedValue(new Error("ws down"));
    mockBroadcastToDaemon.mockRejectedValue(new Error("ws down"));

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("binds the earliest registered token when multiple exist", async () => {
    const POST = await loadRoute();

    const earliestToken = {
      ...registeredToken,
      id: "mt_earliest",
      createdAt: "2025-01-01T00:00:00Z",
    };
    mockGetRegisteredTokenForUser.mockResolvedValue(earliestToken);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "mem_1" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockBroadcastToDaemon.mockResolvedValue({ sent: 1 });

    const req = new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "sp_ws1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(mockActivateMachineToken).toHaveBeenCalledWith(
      expect.anything(),
      "mt_earliest",
      "sp_ws1",
    );
  });
});
