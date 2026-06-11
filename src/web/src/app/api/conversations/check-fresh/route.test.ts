import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetConversation = vi.fn();
const mockGetOrCreate = vi.fn();
const mockGetNewestMessageId = vi.fn();
const mockGetActiveMessageCount = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      conversation: {
        getConversation: (...a: unknown[]) => mockGetConversation(...a),
        getOrCreateAgentConversation: (...a: unknown[]) => mockGetOrCreate(...a),
      },
      message: {
        getNewestMessageId: (...a: unknown[]) => mockGetNewestMessageId(...a),
        getActiveMessageCount: (...a: unknown[]) => mockGetActiveMessageCount(...a),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/conversations/check-fresh", () => {
  it("returns freshness for an existing conversation_id (scoped to workspace)", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    mockGetNewestMessageId.mockResolvedValue("m9");
    mockGetActiveMessageCount.mockResolvedValue(3);

    const req = new NextRequest("http://localhost/api/conversations/check-fresh?conversation_id=c1");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ conversation_id: "c1", newest_message_id: "m9", message_count: 3 });
    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("404 when conversation_id not found in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/conversations/check-fresh?conversation_id=cX");
    const res = await GET(req, {});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found");
  });

  it("resolves via agent_id when no conversation_id given", async () => {
    mockGetOrCreate.mockResolvedValue({ id: "c2" });
    mockGetNewestMessageId.mockResolvedValue(null);
    mockGetActiveMessageCount.mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/conversations/check-fresh?agent_id=a1&channel=general");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation_id).toBe("c2");
    expect(mockGetOrCreate).toHaveBeenCalledWith({}, "w1", "u1", "a1", "general");
  });

  it("400 when neither conversation_id nor agent_id provided", async () => {
    const req = new NextRequest("http://localhost/api/conversations/check-fresh");
    const res = await GET(req, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conversation_id or agent_id is required");
  });
});
