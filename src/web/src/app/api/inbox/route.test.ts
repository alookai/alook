import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListUnreadConversations = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    inbox: {
      listUnreadConversations: (...args: unknown[]) => mockListUnreadConversations(...args),
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

import { GET } from "./route";

describe("GET /api/inbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns items and has_more with default limit", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [{ id: "c1" }], hasMore: false });

    const res = await GET(new NextRequest("http://localhost/api/inbox"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ items: [{ id: "c1" }], has_more: false });
    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      { limit: 30, before: undefined, types: ["user_dm_message"] }
    );
  });

  it("clamps limit to minimum 1", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox?limit=-5"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ limit: 1 })
    );
  });

  it("clamps limit to maximum 100", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox?limit=999"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ limit: 100 })
    );
  });

  it("passes valid before timestamp", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox?before=2026-01-01T00:00:00Z"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ before: "2026-01-01T00:00:00Z" })
    );
  });

  it("returns 400 for invalid before timestamp", async () => {
    const res = await GET(new NextRequest("http://localhost/api/inbox?before=not-a-date"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid before timestamp");
    expect(mockListUnreadConversations).not.toHaveBeenCalled();
  });

  it("filters types param by valid types", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox?types=calendar_event,email_notification"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ types: ["calendar_event", "email_notification"] })
    );
  });

  it("ignores invalid types and defaults to user_dm_message", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox?types=bogus,invalid"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ types: ["user_dm_message"] })
    );
  });

  it("defaults to user_dm_message when no types param", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [], hasMore: false });

    await GET(new NextRequest("http://localhost/api/inbox"));

    expect(mockListUnreadConversations).toHaveBeenCalledWith(
      {},
      "u1",
      "w1",
      expect.objectContaining({ types: ["user_dm_message"] })
    );
  });

  it("returns has_more true when there are more items", async () => {
    mockListUnreadConversations.mockResolvedValue({ items: [{ id: "c1" }], hasMore: true });

    const res = await GET(new NextRequest("http://localhost/api/inbox?limit=1"));
    const body = await res.json();

    expect(body.has_more).toBe(true);
  });
});
