import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetUnreadCount = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    inbox: {
      getUnreadCount: (...args: unknown[]) => mockGetUnreadCount(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, fn: () => any) => fn()),
  cacheKeys: { inboxCount: vi.fn(() => "test-key") },
}));

import { GET } from "./route";

describe("GET /api/inbox/count", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns unread count with default types", async () => {
    mockGetUnreadCount.mockResolvedValue(5);

    const res = await GET(new NextRequest("http://localhost/api/inbox/count"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ count: 5 });
    expect(mockGetUnreadCount).toHaveBeenCalledWith({}, "u1", "w1", ["user_dm_message"]);
  });

  it("filters types param by valid types", async () => {
    mockGetUnreadCount.mockResolvedValue(2);

    const res = await GET(
      new NextRequest("http://localhost/api/inbox/count?types=calendar_event,email_notification")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ count: 2 });
    expect(mockGetUnreadCount).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      ["calendar_event", "email_notification"]
    );
  });

  it("defaults to user_dm_message when all types are invalid", async () => {
    mockGetUnreadCount.mockResolvedValue(0);

    await GET(new NextRequest("http://localhost/api/inbox/count?types=bogus"));

    expect(mockGetUnreadCount).toHaveBeenCalledWith({}, "u1", "w1", ["user_dm_message"]);
  });

  it("returns count 0 when no unread items", async () => {
    mockGetUnreadCount.mockResolvedValue(0);

    const res = await GET(new NextRequest("http://localhost/api/inbox/count"));
    const body = await res.json();

    expect(body).toEqual({ count: 0 });
  });

  it("uses cached wrapper with correct key and ttl", async () => {
    mockGetUnreadCount.mockResolvedValue(3);
    const { cached, cacheKeys } = await import("@/lib/cache");

    await GET(new NextRequest("http://localhost/api/inbox/count"));

    expect(cacheKeys.inboxCount).toHaveBeenCalledWith("u1", "w1", ["user_dm_message"]);
    expect(cached).toHaveBeenCalledWith("test-key", 60, expect.any(Function));
  });
});
