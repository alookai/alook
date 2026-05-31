import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetConversation = vi.fn();
const mockGetMessage = vi.fn();
const mockDeleteBuffered = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      conversation: { getConversation: (...a: unknown[]) => mockGetConversation(...a) },
      message: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        deleteBufferedMessage: (...a: unknown[]) => mockDeleteBuffered(...a),
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
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn().mockResolvedValue(undefined) }));

import { DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

function del(params: Record<string, string>) {
  const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages/m1", {
    method: "DELETE",
  });
  return DELETE(req, { params });
}

describe("DELETE /api/conversations/[id]/buffered-messages/[messageId]", () => {
  it("deletes a buffered message scoped to the workspace conversation", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1" });
    mockGetMessage.mockResolvedValue({ id: "m1", conversationId: "c1", status: "buffered" });
    mockDeleteBuffered.mockResolvedValue(undefined);

    const res = await del({ id: "c1", messageId: "m1" });
    expect(res.status).toBe(204);
    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
    expect(mockDeleteBuffered).toHaveBeenCalledWith({}, "m1");
  });

  it("400 when conversation id missing", async () => {
    const res = await del({ messageId: "m1" });
    expect(res.status).toBe(400);
  });

  it("400 when message id missing", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1" });
    const res = await del({ id: "c1" });
    expect(res.status).toBe(400);
  });

  it("404 when conversation not in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const res = await del({ id: "c1", messageId: "m1" });
    expect(res.status).toBe(404);
  });

  it("404 when message not found or belongs to a different conversation (IDOR guard)", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1" });
    mockGetMessage.mockResolvedValue({ id: "m1", conversationId: "OTHER", status: "buffered" });
    const res = await del({ id: "c1", messageId: "m1" });
    expect(res.status).toBe(404);
    expect(mockDeleteBuffered).not.toHaveBeenCalled();
  });

  it("400 when message is not in buffered status", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1" });
    mockGetMessage.mockResolvedValue({ id: "m1", conversationId: "c1", status: "sent" });
    const res = await del({ id: "c1", messageId: "m1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("message is not buffered");
  });
});
