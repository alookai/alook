import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMachineTokenByToken = vi.fn();
const mockActivateMachineToken = vi.fn();
const mockUpsertMachine = vi.fn();
const mockUpsertAgentRuntime = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockListWorkspaces = vi.fn();
const mockCreateWorkspace = vi.fn();
const mockCreateMember = vi.fn();

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
        workspace: {
          listWorkspaces: (...a: any[]) => mockListWorkspaces(...a),
          createWorkspace: (...a: any[]) => mockCreateWorkspace(...a),
        },
        member: {
          createMember: (...a: any[]) => mockCreateMember(...a),
        },
      },
      ActivateTokenRequestSchema: (await import("@alook/shared"))
        .ActivateTokenRequestSchema,
      generateWorkspaceSlug: () => "studio-test1234",
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
    },
    "@/lib/api/responses": {
      runtimeToResponse: (rt: any) => ({ id: rt.id, provider: rt.provider }),
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
    vi.doMock("@/lib/api/responses", () => mocks["@/lib/api/responses"]);
    vi.doMock("@/lib/middleware/helpers", async () => {
      return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      );
    });

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
    workspaceId: "sp_correct_workspace",
    status: "pending",
  };

  it("returns workspace_id in the response", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("sp_correct_workspace");
    expect(body.daemon_id).toBe("TestMachine.local");
    expect(body.runtimes).toHaveLength(1);
  });

  it("returns 404 when token not found", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(null);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("token not found");
    expect(mockUpsertMachine).not.toHaveBeenCalled();
  });

  it("returns 409 when token already used", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue({ ...pendingToken, status: "active" });

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("token already used");
    expect(mockUpsertMachine).not.toHaveBeenCalled();
  });

  it("creates machine and runtime with token's workspace_id", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    expect(mockUpsertMachine).toHaveBeenCalledWith(expect.anything(), {
      daemonId: "TestMachine.local",
      workspaceId: "sp_correct_workspace",
      deviceInfo: "TestMachine.local",
      lastSeenAt: null,
    });

    expect(mockUpsertAgentRuntime).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "sp_correct_workspace",
      daemonId: "TestMachine.local",
      runtimeMode: "local",
      provider: "claude",
      deviceInfo: "TestMachine.local",
      metadata: { version: "2.1.0" },
    });
  });

  it("creates a new workspace when token has no workspace_id", async () => {
    const POST = await loadRoute();

    const tokenNoWs = { id: "mt_2", userId: "u1", workspaceId: null, status: "pending" };
    mockGetMachineTokenByToken.mockResolvedValue(tokenNoWs);
    mockCreateWorkspace.mockResolvedValue({ id: "sp_new_ws" });
    mockCreateMember.mockResolvedValue(undefined);
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
    mockActivateMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("sp_new_ws");
    expect(mockCreateWorkspace).toHaveBeenCalledWith(expect.anything(), {
      name: "Personal",
      slug: "studio-test1234",
    });
    expect(mockCreateMember).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "sp_new_ws",
      userId: "u1",
      role: "owner",
    });
  });
});
