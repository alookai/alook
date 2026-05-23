import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockUpsertMachine = vi.fn();
const mockGetMachineByDaemon = vi.fn();
const mockBroadcastToUser = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {} },
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
        getMachineByDaemon: (...args: unknown[]) => mockGetMachineByDaemon(...args),
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
    mockGetMachineByDaemon.mockResolvedValue(null);
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

  it("upserts machine in D1 on every heartbeat", async () => {
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockUpsertMachine).toHaveBeenCalledWith({}, {
      daemonId: "d1",
      workspaceId: "w1",
      deviceInfo: "d1",
    });
  });

  it("broadcasts runtime.status when daemon transitions from offline to online", async () => {
    mockGetMachineByDaemon.mockResolvedValue(null);
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.status",
      daemonId: "d1",
      workspaceId: "w1",
      status: "online",
    });
  });

  it("broadcasts when last_seen_at exceeds offline threshold", async () => {
    mockGetMachineByDaemon.mockResolvedValue({ lastSeenAt: new Date(Date.now() - 30_000).toISOString() });
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      type: "runtime.status",
      status: "online",
    }));
  });

  it("does not broadcast when daemon was already online", async () => {
    mockGetMachineByDaemon.mockResolvedValue({ lastSeenAt: new Date().toISOString() });
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
      getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
    }));
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@alook/shared", async () => {
      const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
      return { ...real, queries: { machine: { upsertMachine: vi.fn(), getMachineByDaemon: vi.fn() } } };
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

    const { POST: POST2 } = await import("./route");
    const res = await POST2(postReq({ daemon_id: "d1" }));
    expect(res.status).toBe(403);
  });
});
