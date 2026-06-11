import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockDeleteConversation = vi.fn();
const mockDeleteTasksByConversation = vi.fn();
const mockDeleteUnreadByConversation = vi.fn();
const mockConversationToResponse = vi.fn((c: any) => ({ id: c.id, title: c.title }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    conversation: {
      getConversation: (...args: any[]) => mockGetConversation(...args),
      deleteConversation: (...args: any[]) => mockDeleteConversation(...args),
    },
    task: {
      deleteTasksByConversation: (...args: any[]) => mockDeleteTasksByConversation(...args),
    },
    inbox: {
      deleteUnreadByConversation: (...args: any[]) => mockDeleteUnreadByConversation(...args),
    },
  },
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/api/responses", () => ({
  conversationToResponse: (...args: any[]) => mockConversationToResponse(...args),
}));

import { GET, DELETE } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/conversations/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns conversation scoped by workspaceId", async () => {
    const conv = { id: "c1", title: "Test", workspaceId: "w1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1"),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "c1", title: "Test" });
    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("returns 404 when not found", async () => {
    mockGetConversation.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1"),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});

describe("DELETE /api/conversations/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 204 and removes conversation + tasks with workspace scoping", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", workspaceId: "w1", userId: "u1" });
    mockDeleteTasksByConversation.mockResolvedValue(undefined);
    mockDeleteConversation.mockResolvedValue(undefined);

    const res = await DELETE(
      new NextRequest("http://localhost/api/conversations/c1", { method: "DELETE" }),
      withParams("c1")
    );

    expect(res.status).toBe(204);
    expect(mockDeleteTasksByConversation).toHaveBeenCalledWith({}, "c1", "w1");
    expect(mockDeleteConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("deletes tasks before conversation", async () => {
    const callOrder: string[] = [];
    mockGetConversation.mockResolvedValue({ id: "c1", workspaceId: "w1", userId: "u1" });
    mockDeleteTasksByConversation.mockImplementation(async () => {
      callOrder.push("tasks");
    });
    mockDeleteUnreadByConversation.mockImplementation(async () => {
      callOrder.push("unread");
    });
    mockDeleteConversation.mockImplementation(async () => {
      callOrder.push("conversation");
    });

    await DELETE(
      new NextRequest("http://localhost/api/conversations/c1", { method: "DELETE" }),
      withParams("c1")
    );

    expect(callOrder).toEqual(["tasks", "unread", "conversation"]);
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversation.mockResolvedValue(null);

    const res = await DELETE(
      new NextRequest("http://localhost/api/conversations/c1", { method: "DELETE" }),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});
