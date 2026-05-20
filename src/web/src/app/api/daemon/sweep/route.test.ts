import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockSweepStaleState = vi.fn();
const mockPromoteDue = vi.fn(async () => 0);

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      CACHE_KV: {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
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
  return { ...real };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any) => {
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1" });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/services/sweep", () => ({
  sweepStaleState: (...args: unknown[]) => mockSweepStaleState(...args),
}));

vi.mock("@/lib/services/calendar", () => ({
  promoteDueCalendarEventsForWorkspace: (...args: unknown[]) => mockPromoteDue(...args),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/cache", () => ({
  throttled: vi.fn((_key: string, _interval: number, fn: () => Promise<any>) => fn()),
}));

import { POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/sweep", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSweepStaleState.mockResolvedValue(undefined);
    mockPromoteDue.mockResolvedValue(0);
  });

  it("returns 403 without machine token auth", async () => {
    vi.resetModules();

    vi.doMock("@opennextjs/cloudflare", () => ({
      getCloudflareContext: vi.fn(() => ({
        env: { DB: {}, CACHE_KV: { put: vi.fn(), get: vi.fn().mockResolvedValue(null), delete: vi.fn() } },
      })),
    }));
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@alook/shared", async () => {
      const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
      return { ...real };
    });
    vi.doMock("@/lib/middleware/auth", () => ({
      withAuth: vi.fn((handler: any) => async (req: any) => {
        return handler(req, { userId: "u1", email: "u@t.com" });
      }),
    }));
    vi.doMock("@/lib/middleware/helpers", async () =>
      await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
    );
    vi.doMock("@/lib/services/sweep", () => ({ sweepStaleState: vi.fn() }));
    vi.doMock("@/lib/services/calendar", () => ({ promoteDueCalendarEventsForWorkspace: vi.fn() }));
    vi.doMock("@/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
    vi.doMock("@/lib/cache", () => ({ throttled: vi.fn((_k: string, _i: number, fn: () => Promise<any>) => fn()) }));

    const { POST: POST2 } = await import("./route");
    const res = await POST2(postReq({ daemon_id: "d1" }));
    expect(res.status).toBe(403);
  });

  it("calls sweepStaleState with correct db and workspaceId", async () => {
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockSweepStaleState).toHaveBeenCalledWith({}, "w1");
  });

  it("calls promoteDueCalendarEventsForWorkspace (throttled)", async () => {
    await POST(postReq({ daemon_id: "d1" }));

    expect(mockPromoteDue).toHaveBeenCalledWith({}, "w1");
  });

  it("returns { ok: true } on success", async () => {
    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("survives sweepStaleState throwing (still returns 200)", async () => {
    mockSweepStaleState.mockRejectedValue(new Error("D1 timeout"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("survives calendar promotion throwing (still returns 200)", async () => {
    mockPromoteDue.mockRejectedValue(new Error("calendar error"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
