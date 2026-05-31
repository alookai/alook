import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, EMAIL_BUCKET: { put: vi.fn() } } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "xyz") }));

const mockGetConversation = vi.fn();
const mockListBuffered = vi.fn();
const mockCountBuffered = vi.fn();
const mockCreateBuffered = vi.fn();
const mockDeleteAllBuffered = vi.fn();
const mockGetActiveTask = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    parsePromptMentions: vi.fn((c: string) => ({ enrichedPrompt: c })),
    queries: {
      conversation: { getConversation: (...a: unknown[]) => mockGetConversation(...a) },
      message: {
        listBufferedMessages: (...a: unknown[]) => mockListBuffered(...a),
        countBufferedMessages: (...a: unknown[]) => mockCountBuffered(...a),
        createBufferedMessage: (...a: unknown[]) => mockCreateBuffered(...a),
        deleteAllBufferedMessages: (...a: unknown[]) => mockDeleteAllBuffered(...a),
      },
      task: { getActiveTaskByConversation: (...a: unknown[]) => mockGetActiveTask(...a) },
      artifact: { createArtifact: vi.fn() },
      agent: { listAgents: vi.fn().mockResolvedValue([]) },
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
  messageToResponse: vi.fn((m: any) => ({ id: m.id, content: m.content })),
}));
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  cacheKeys: { overviewTaskStats: (w: string, d: string) => `ov:${w}:${d}` },
}));
const mockDispatch = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/services/task", () => ({
  TaskService: function () { return { dispatchNextBufferedMessage: mockDispatch }; },
}));

import { GET, POST, DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/conversations/[id]/buffered-messages", () => {
  it("lists buffered messages for a workspace conversation", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockListBuffered.mockResolvedValue([{ id: "m1", content: "hi" }]);

    const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages");
    const res = await GET(req, { params: { id: "c1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "m1", content: "hi" }]);
    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("400 when id missing", async () => {
    const req = new NextRequest("http://localhost/api/conversations/x/buffered-messages");
    const res = await GET(req, { params: {} });
    expect(res.status).toBe(400);
  });

  it("404 when conversation not in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages");
    const res = await GET(req, { params: { id: "c1" } });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/conversations/[id]/buffered-messages (JSON)", () => {
  function post(body: unknown, id = "c1") {
    const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req, { params: { id } });
  }

  it("creates a buffered message and dispatches when no active task", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockCountBuffered.mockResolvedValue(0);
    mockCreateBuffered.mockResolvedValue({ id: "m1", content: "hello" });
    mockGetActiveTask.mockResolvedValue(null);

    const res = await post({ content: "hello" });
    expect(res.status).toBe(201);
    expect((await res.json()).message).toEqual({ id: "m1", content: "hello" });
    expect(mockDispatch).toHaveBeenCalledWith("c1", "w1");
  });

  it("does NOT dispatch when an active task already exists", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockCountBuffered.mockResolvedValue(0);
    mockCreateBuffered.mockResolvedValue({ id: "m1", content: "hello" });
    mockGetActiveTask.mockResolvedValue({ id: "t1" });

    const res = await post({ content: "hello" });
    expect(res.status).toBe(201);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("404 when conversation not in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const res = await post({ content: "hello" });
    expect(res.status).toBe(404);
  });

  it("429 when buffered limit reached", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockCountBuffered.mockResolvedValue(20);
    const res = await post({ content: "hello" });
    expect(res.status).toBe(429);
  });

  it("400 on invalid JSON body (schema validation)", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockCountBuffered.mockResolvedValue(0);
    const res = await post({ notContent: 1 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/conversations/[id]/buffered-messages", () => {
  it("clears all buffered messages (204)", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockDeleteAllBuffered.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);

    const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: { id: "c1" } });
    expect(res.status).toBe(204);
    expect(mockDeleteAllBuffered).toHaveBeenCalledWith({}, "c1");
  });

  it("404 when conversation not in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/conversations/c1/buffered-messages", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: { id: "c1" } });
    expect(res.status).toBe(404);
  });
});
