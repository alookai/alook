import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetRuntimeIdsByDaemon = vi.fn();
const mockSetAgentRuntimeOffline = vi.fn();
const mockBroadcastToUser = vi.fn();

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        runtime: {
          getRuntimeIdsByDaemon: (...a: any[]) =>
            mockGetRuntimeIdsByDaemon(...a),
          setAgentRuntimeOffline: (...a: any[]) =>
            mockSetAgentRuntimeOffline(...a),
        },
      },
      DeregisterRequestSchema: (await import("@alook/shared"))
        .DeregisterRequestSchema,
    }),
    "@/lib/logger": {
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
    },
  };
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/deregister", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/deregister", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadRoute(authCtx: Record<string, unknown>) {
    vi.resetModules();

    const mocks = sharedMocks();

    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/logger", () => mocks["@/lib/logger"]);
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
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

  const daemonAuth = { userId: "u1", email: "u@t.com", workspaceId: "w1" };
  const jwtAuth = { userId: "u1", email: "u@t.com" };

  it("sets all runtimes for daemon offline", async () => {
    const POST = await loadRoute(daemonAuth);

    mockGetRuntimeIdsByDaemon.mockResolvedValue(["rt1", "rt2"]);
    mockSetAgentRuntimeOffline.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(mockGetRuntimeIdsByDaemon).toHaveBeenCalledWith({}, "d1", "w1");
    expect(mockSetAgentRuntimeOffline).toHaveBeenCalledTimes(2);
    expect(mockSetAgentRuntimeOffline).toHaveBeenCalledWith({}, "rt1");
    expect(mockSetAgentRuntimeOffline).toHaveBeenCalledWith({}, "rt2");
  });

  it("sends single broadcast with daemonId and workspaceId", async () => {
    const POST = await loadRoute(daemonAuth);

    mockGetRuntimeIdsByDaemon.mockResolvedValue(["rt1", "rt2"]);
    mockSetAgentRuntimeOffline.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq({ daemon_id: "d1" }));

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.status",
      daemonId: "d1",
      workspaceId: "w1",
      status: "offline",
    });
  });

  it("returns 200 with no broadcast when daemon has no runtimes", async () => {
    const POST = await loadRoute(daemonAuth);

    mockGetRuntimeIdsByDaemon.mockResolvedValue([]);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(mockSetAgentRuntimeOffline).not.toHaveBeenCalled();
    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 403 when called without workspaceId", async () => {
    const POST = await loadRoute(jwtAuth);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("machine token required");
  });

  it("continues processing remaining runtimes after DB error on one", async () => {
    const POST = await loadRoute(daemonAuth);

    mockGetRuntimeIdsByDaemon.mockResolvedValue(["rt1", "rt2"]);
    mockSetAgentRuntimeOffline
      .mockRejectedValueOnce(new Error("DB connection lost"))
      .mockResolvedValueOnce(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(mockSetAgentRuntimeOffline).toHaveBeenCalledTimes(2);
  });
});
