import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockUpsertMachine = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockKvPut = vi.fn().mockResolvedValue(undefined);
const mockKvGet = vi.fn().mockResolvedValue(null);

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      CACHE_KV: {
        put: (...args: unknown[]) => mockKvPut(...args),
        get: (...args: unknown[]) => mockKvGet(...args),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    },
  })),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      machine: {
        upsertMachine: (...args: unknown[]) => mockUpsertMachine(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any) => {
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1" });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...args: unknown[]) => mockBroadcastToUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/cache", () => ({
  cacheKeys: {
    heartbeat: (wsId: string, daemonId: string) => `hb:${wsId}:${daemonId}`,
  },
  throttled: vi.fn((_key: string, _interval: number, fn: () => Promise<void>) => fn().then(() => true)),
}));

import { POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/heartbeat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertMachine.mockResolvedValue({});
    mockBroadcastToUser.mockResolvedValue(undefined);
  });

  it("returns 400 when daemon_id is missing", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when daemon_id is empty", async () => {
    const res = await POST(postReq({ daemon_id: "" }));
    expect(res.status).toBe(400);
  });

  it("returns ok: true on valid request", async () => {
    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("writes KV heartbeat with 120s TTL", async () => {
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockKvPut).toHaveBeenCalledWith(
      "hb:w1:d1",
      expect.any(String),
      { expirationTtl: 120 },
    );
  });

  it("upserts machine via throttled D1 write", async () => {
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockUpsertMachine).toHaveBeenCalledWith({}, {
      daemonId: "d1",
      workspaceId: "w1",
      deviceInfo: "d1",
    });
  });

  it("broadcasts runtime.status when daemon transitions from offline to online", async () => {
    mockKvGet.mockResolvedValue(null);
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.status",
      daemonId: "d1",
      workspaceId: "w1",
      status: "online",
    });
  });

  it("does not broadcast when daemon was already online", async () => {
    mockKvGet.mockResolvedValue("2026-05-20T10:00:00.000Z");
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });

  it("does not fail when upsertMachine throws", async () => {
    mockUpsertMachine.mockRejectedValue(new Error("D1 timeout"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("requires machine token (workspaceId must be present)", async () => {
    vi.resetModules();

    vi.doMock("@opennextjs/cloudflare", () => ({
      getCloudflareContext: vi.fn(() => ({
        env: { DB: {}, CACHE_KV: { put: vi.fn(), get: vi.fn().mockResolvedValue(null) } },
      })),
    }));
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@alook/shared", async () => {
      const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
      return { ...real, queries: { machine: { upsertMachine: vi.fn() } } };
    });
    vi.doMock("@/lib/middleware/auth", () => ({
      withAuth: vi.fn((handler: any) => async (req: any) => {
        return handler(req, { userId: "u1", email: "u@t.com" });
      }),
    }));
    vi.doMock("@/lib/middleware/helpers", async () =>
      await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
    );
    vi.doMock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn() }));
    vi.doMock("@/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
    vi.doMock("@/lib/cache", () => ({
      cacheKeys: { heartbeat: (wsId: string, daemonId: string) => `hb:${wsId}:${daemonId}` },
      throttled: vi.fn((_k: string, _i: number, fn: () => Promise<void>) => fn().then(() => true)),
    }));

    const { POST: POST2 } = await import("./route");
    const res = await POST2(postReq({ daemon_id: "d1" }));
    expect(res.status).toBe(403);
  });
});
