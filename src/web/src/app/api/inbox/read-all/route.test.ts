import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockMarkAllConversationsRead = vi.fn();
const mockInvalidateInboxCounts = vi.fn().mockResolvedValue(undefined);

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    inbox: {
      markAllConversationsRead: (...args: unknown[]) => mockMarkAllConversationsRead(...args),
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

vi.mock("@/lib/cache", () => ({
  invalidateInboxCounts: (...args: unknown[]) => mockInvalidateInboxCounts(...args),
}));

import { POST } from "./route";

describe("POST /api/inbox/read-all", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks all conversations read and returns 204", async () => {
    mockMarkAllConversationsRead.mockResolvedValue(undefined);

    const res = await POST(
      new NextRequest("http://localhost/api/inbox/read-all", { method: "POST" })
    );

    expect(res.status).toBe(204);
    expect(mockMarkAllConversationsRead).toHaveBeenCalledWith({}, "u1", "w1");
    expect(mockInvalidateInboxCounts).toHaveBeenCalledWith("u1", "w1");
  });

  it("does not fail if invalidateInboxCounts rejects", async () => {
    mockMarkAllConversationsRead.mockResolvedValue(undefined);
    mockInvalidateInboxCounts.mockRejectedValue(new Error("cache error"));

    const res = await POST(
      new NextRequest("http://localhost/api/inbox/read-all", { method: "POST" })
    );

    expect(res.status).toBe(204);
    expect(mockMarkAllConversationsRead).toHaveBeenCalledWith({}, "u1", "w1");
  });

  it("calls markAllConversationsRead with correct workspace and user", async () => {
    mockMarkAllConversationsRead.mockResolvedValue(undefined);

    await POST(new NextRequest("http://localhost/api/inbox/read-all", { method: "POST" }));

    expect(mockMarkAllConversationsRead).toHaveBeenCalledTimes(1);
    expect(mockMarkAllConversationsRead).toHaveBeenCalledWith({}, "u1", "w1");
  });
});
