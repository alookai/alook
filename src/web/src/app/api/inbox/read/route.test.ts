import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockMarkConversationRead = vi.fn();
const mockInvalidateInboxCounts = vi.fn().mockResolvedValue(undefined);

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    conversation: {
      getConversation: (...args: unknown[]) => mockGetConversation(...args),
    },
    inbox: {
      markConversationRead: (...args: unknown[]) => mockMarkConversationRead(...args),
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

describe("POST /api/inbox/read", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeRequest(body?: string) {
    return new NextRequest("http://localhost/api/inbox/read", {
      method: "POST",
      body,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    });
  }

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(makeRequest("not-json"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid JSON body");
  });

  it("returns 400 when conversationId is missing", async () => {
    const res = await POST(makeRequest(JSON.stringify({})));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("conversationId is required");
  });

  it("returns 400 when conversationId is empty string", async () => {
    const res = await POST(makeRequest(JSON.stringify({ conversationId: "" })));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("conversationId is required");
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversation.mockResolvedValue(null);

    const res = await POST(makeRequest(JSON.stringify({ conversationId: "c1" })));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("conversation not found");
    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("returns 404 when conversation belongs to different user", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "other-user" });

    const res = await POST(makeRequest(JSON.stringify({ conversationId: "c1" })));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("conversation not found");
  });

  it("marks conversation as read and returns 204", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    mockMarkConversationRead.mockResolvedValue(undefined);

    const res = await POST(makeRequest(JSON.stringify({ conversationId: "c1" })));

    expect(res.status).toBe(204);
    expect(mockMarkConversationRead).toHaveBeenCalledWith({}, "u1", "c1");
    expect(mockInvalidateInboxCounts).toHaveBeenCalledWith("u1", "w1");
  });

  it("does not fail if invalidateInboxCounts rejects", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    mockMarkConversationRead.mockResolvedValue(undefined);
    mockInvalidateInboxCounts.mockRejectedValue(new Error("cache error"));

    const res = await POST(makeRequest(JSON.stringify({ conversationId: "c1" })));

    expect(res.status).toBe(204);
  });
});
