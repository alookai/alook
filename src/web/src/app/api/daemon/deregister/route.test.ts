import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockSetMachineLastSeenNull = vi.fn();
const mockBroadcastToUser = vi.fn();

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        machine: {
          setMachineLastSeenNull: (...a: any[]) =>
            mockSetMachineLastSeenNull(...a),
        },
      },
      DeregisterRequestSchema: (await import("@alook/shared"))
        .DeregisterRequestSchema,
    }),
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
    vi.doMock("@/lib/db", () => ({
      getDb: vi.fn(() => ({})),
      withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
    }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/logger", () => ({
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
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

  const daemonAuth = { userId: "u1", email: "u@t.com", workspaceId: "w1" };
  const jwtAuth = { userId: "u1", email: "u@t.com" };

  it("sets machine last_seen_at to null", async () => {
    const POST = await loadRoute(daemonAuth);

    mockSetMachineLastSeenNull.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    // Single machine write instead of N runtime writes
    expect(mockSetMachineLastSeenNull).toHaveBeenCalledTimes(1);
    expect(mockSetMachineLastSeenNull).toHaveBeenCalledWith({}, "d1", "w1");
  });

  it("sends single broadcast with daemonId and workspaceId", async () => {
    const POST = await loadRoute(daemonAuth);

    mockSetMachineLastSeenNull.mockResolvedValue(undefined);
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

  it("returns 403 when called without workspaceId", async () => {
    const POST = await loadRoute(jwtAuth);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("machine token required");
  });

  it("still returns ok when setMachineLastSeenNull fails (D1 transient error)", async () => {
    const POST = await loadRoute(daemonAuth);

    mockSetMachineLastSeenNull.mockRejectedValue(new Error("D1 timeout"));
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });
});
