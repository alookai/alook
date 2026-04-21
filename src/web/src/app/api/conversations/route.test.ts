import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListConversations = vi.fn();
const mockCreateConversation = vi.fn();
const mockConversationToResponse = vi.fn((c: any) => ({ id: c.id, title: c.title }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      conversation: {
        listConversations: (...args: any[]) => mockListConversations(...args),
        createConversation: (...args: any[]) => mockCreateConversation(...args),
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
vi.mock("@/lib/api/responses", () => ({
  conversationToResponse: (...args: any[]) => mockConversationToResponse(...args),
}));

import { GET, POST } from "./route";

describe("GET /api/conversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists conversations", async () => {
    const convs = [
      { id: "c1", title: "Hello" },
      { id: "c2", title: "World" },
    ];
    mockListConversations.mockResolvedValue(convs);

    const res = await GET(new NextRequest("http://localhost/api/conversations"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "c1", title: "Hello" },
      { id: "c2", title: "World" },
    ]);
    expect(mockListConversations).toHaveBeenCalledWith({}, "w1", "u1");
  });
});

describe("POST /api/conversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a conversation with agent_id", async () => {
    const conv = { id: "c1", title: "" };
    mockCreateConversation.mockResolvedValue(conv);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations", {
        method: "POST",
        body: JSON.stringify({ agent_id: "a1" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ id: "c1", title: "" });
    expect(mockCreateConversation).toHaveBeenCalledWith({}, {
      workspaceId: "w1",
      agentId: "a1",
      userId: "u1",
      title: "",
    });
  });

  it("returns 400 for missing agent_id", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/conversations", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("validation error");
    expect(body.details).toContainEqual(expect.stringContaining("agent_id"));
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/conversations", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid request body");
  });
});
