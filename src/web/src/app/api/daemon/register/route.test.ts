import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMember = vi.fn();
const mockUpsertMachine = vi.fn();
const mockUpsertAgentRuntime = vi.fn();
const mockBroadcastToUser = vi.fn();

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        member: {
          getMemberByUserAndWorkspace: (...a: any[]) => mockGetMember(...a),
        },
        machine: {
          upsertMachine: (...a: any[]) => mockUpsertMachine(...a),
        },
        runtime: {
          upsertAgentRuntime: (...a: any[]) => mockUpsertAgentRuntime(...a),
        },
      },
      RegisterDaemonRequestSchema: (await import("@alook/shared"))
        .RegisterDaemonRequestSchema,
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
    },
    "@/lib/api/responses": {
      runtimeToResponse: (rt: any) => ({ id: rt.id }),
    },
  };
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/register", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/register", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadRoute(authCtx: Record<string, unknown>) {
    vi.resetModules();

    const mocks = sharedMocks();

    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/api/responses", () => mocks["@/lib/api/responses"]);
    vi.doMock("@/lib/cache", () => ({
      invalidate: vi.fn(),
      cacheKeys: { runtimeIds: (...a: any[]) => a.join(":") },
    }));
    vi.doMock("@/lib/middleware/auth", () => ({
      withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
        const params =
          ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
        return handler(req, { ...authCtx, params });
      }),
    }));
    vi.doMock("@/lib/middleware/helpers", async () => {
      return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      );
    });

    const { POST } = await import("./route");
    return POST;
  }

  const validBody = {
    workspace_id: "w1",
    daemon_id: "d1",
    device_name: "MyMachine",
    cli_version: "0.0.2",
    runtimes: [
      { type: "claude", version: "1.0", runtime_mode: "local" },
    ],
  };

  const authCtx = { userId: "u1", email: "u@t.com" };

  it("upserts machine + runtimes and returns 200", async () => {
    const POST = await loadRoute(authCtx);

    mockGetMember.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1" });
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ runtimes: [{ id: "r1" }], workspaceId: "w1" });
    expect(mockUpsertMachine).toHaveBeenCalledTimes(1);
    expect(mockUpsertAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("broadcasts runtime.registered after upserts", async () => {
    const POST = await loadRoute(authCtx);

    mockGetMember.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1" });
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.registered",
      daemonId: "d1",
      hostname: "MyMachine",
      workspaceId: "w1",
    });
  });

  it("returns 404 when membership is missing and does not broadcast", async () => {
    const POST = await loadRoute(authCtx);

    mockGetMember.mockResolvedValue(null);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("workspace not found");
    expect(mockUpsertMachine).not.toHaveBeenCalled();
    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 403 when token workspace_id does not match body workspace_id", async () => {
    const POST = await loadRoute({ ...authCtx, workspaceId: "w_other" });

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("workspace_id does not match token");
    expect(mockGetMember).not.toHaveBeenCalled();
    expect(mockUpsertMachine).not.toHaveBeenCalled();
  });

  it("allows register when token workspace_id matches body workspace_id", async () => {
    const POST = await loadRoute({ ...authCtx, workspaceId: "w1" });

    mockGetMember.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1" });
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));

    expect(res.status).toBe(200);
    expect(mockUpsertMachine).toHaveBeenCalledTimes(1);
  });

  it("does not fail the request if broadcast throws (fire-and-forget)", async () => {
    const POST = await loadRoute(authCtx);

    mockGetMember.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
    mockUpsertMachine.mockResolvedValue(undefined);
    mockUpsertAgentRuntime.mockResolvedValue({ id: "r1" });
    mockBroadcastToUser.mockRejectedValue(new Error("ws down"));

    const res = await POST(makeReq(validBody));

    expect(res.status).toBe(200);
  });
});
