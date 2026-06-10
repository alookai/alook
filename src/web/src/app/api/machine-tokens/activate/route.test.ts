import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMachineTokenByToken = vi.fn();
const mockActivateMachineToken = vi.fn();
const mockUpsertMachine = vi.fn();
const mockUpsertAgentRuntime = vi.fn();
const mockBroadcastToUser = vi.fn();

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => Promise.resolve({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        machineToken: {
          getMachineTokenByToken: (...a: any[]) => mockGetMachineTokenByToken(...a),
          activateMachineToken: (...a: any[]) => mockActivateMachineToken(...a),
        },
        machine: {
          upsertMachine: (...a: any[]) => mockUpsertMachine(...a),
        },
        runtime: {
          upsertAgentRuntime: (...a: any[]) => mockUpsertAgentRuntime(...a),
        },
      },
      ActivateTokenRequestSchema: (await import("@alook/shared"))
        .ActivateTokenRequestSchema,
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
    },
  };
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/machine-tokens/activate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/machine-tokens/activate", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadRoute() {
    vi.resetModules();

    const mocks = sharedMocks();

    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/cache", () => ({
      invalidate: vi.fn(() => Promise.resolve()),
      cacheKeys: {
        machineToken: (t: string) => `mt:${t}`,
        runtimeIds: () => "ri:",
        allRuntimes: () => "ar:",
      },
    }));
    vi.doMock("@/lib/middleware/helpers", async () => {
      return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      );
    });
    vi.doMock("@/lib/api/responses", () => ({
      runtimeToResponse: (r: any) => ({ id: r.id, provider: r.provider }),
    }));

    const { POST } = await import("./route");
    return POST;
  }

  const validBody = {
    token: "al_test123",
    hostname: "TestMachine.local",
    runtimes: [{ type: "claude", version: "2.1.0" }],
  };

  const pendingToken = {
    id: "mt_1",
    userId: "u1",
    workspaceId: "ws_1",
    status: "pending",
  };

  it("creates machine + runtime rows and activates token", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "rt_1", provider: "claude" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.daemon_id).toBe("TestMachine.local");
    expect(body.workspace_id).toBe("ws_1");
    expect(body.runtimes).toHaveLength(1);

    expect(mockUpsertMachine).toHaveBeenCalledWith(expect.anything(), {
      daemonId: "TestMachine.local",
      workspaceId: "ws_1",
      deviceInfo: "TestMachine.local",
      lastSeenAt: null,
    });

    expect(mockUpsertAgentRuntime).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      daemonId: "TestMachine.local",
      runtimeMode: "local",
      provider: "claude",
      deviceInfo: "TestMachine.local",
      metadata: { version: "2.1.0" },
    });

    expect(mockActivateMachineToken).toHaveBeenCalledWith(
      expect.anything(),
      "mt_1",
      "TestMachine.local",
    );
  });

  it("broadcasts runtime.registered event", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "rt_1", provider: "claude" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.registered",
      daemonId: "TestMachine.local",
      hostname: "TestMachine.local",
      workspaceId: "ws_1",
    });
  });

  it("returns 404 when token not found", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(null);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("token not found");
  });

  it("returns 409 when token already used", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue({ ...pendingToken, status: "active" });

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("token already used");
  });

  it("returns 422 when token has no workspace_id", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue({ ...pendingToken, workspaceId: null });

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("no workspace_id");
  });
});
