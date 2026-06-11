import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const m = {
  getConversation: vi.fn(),
  getNewestMessageId: vi.fn(),
  getActiveMessageCount: vi.fn(),
  listMessages: vi.fn(),
  listArtifactsByConversation: vi.fn(),
  getActiveTaskByConversation: vi.fn(),
  listFlaggedMessageIds: vi.fn(),
  hasPreviousConversations: vi.fn(),
  listTaskErrorMessages: vi.fn(),
};

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      conversation: {
        getConversation: (...a: unknown[]) => m.getConversation(...a),
        hasPreviousConversations: (...a: unknown[]) => m.hasPreviousConversations(...a),
      },
      message: {
        getNewestMessageId: (...a: unknown[]) => m.getNewestMessageId(...a),
        getActiveMessageCount: (...a: unknown[]) => m.getActiveMessageCount(...a),
        listMessages: (...a: unknown[]) => m.listMessages(...a),
      },
      artifact: {
        listArtifactsByConversation: (...a: unknown[]) => m.listArtifactsByConversation(...a),
        artifactToResponse: (a: any) => a,
      },
      task: { getActiveTaskByConversation: (...a: unknown[]) => m.getActiveTaskByConversation(...a) },
      messageFlag: { listFlaggedMessageIds: (...a: unknown[]) => m.listFlaggedMessageIds(...a) },
      taskMessage: {
        listTaskErrorMessages: (...a: unknown[]) => m.listTaskErrorMessages(...a),
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
  conversationToResponse: (c: any) => ({ id: c.id }),
  messageToResponse: (m: any) => ({ id: m.id }),
  taskToResponse: (t: any) => ({ id: t.id }),
  taskMessageToResponse: (tm: any) => ({ id: tm.id }),
}));
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  m.listMessages.mockResolvedValue({ messages: [], has_more: false });
  m.listArtifactsByConversation.mockResolvedValue([]);
  m.getActiveTaskByConversation.mockResolvedValue(null);
  m.listFlaggedMessageIds.mockResolvedValue([]);
  m.hasPreviousConversations.mockResolvedValue(false);
  m.getActiveMessageCount.mockResolvedValue(0);
  m.getNewestMessageId.mockResolvedValue(null);
});

describe("GET /api/conversations/[id]/init", () => {
  it("400 when conversation id missing", async () => {
    const req = new NextRequest("http://localhost/api/conversations/x/init");
    const res = await GET(req, { params: {} });
    expect(res.status).toBe(400);
  });

  it("404 when conversation not in workspace", async () => {
    m.getConversation.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/conversations/c1/init");
    const res = await GET(req, { params: { id: "c1" } });
    expect(res.status).toBe(404);
    expect(mockScoped()).toBe(true);
  });

  it("returns the init payload with messages when no cache hint", async () => {
    m.getConversation.mockResolvedValue({ id: "c1", agentId: "a1", channel: null, userId: "u1" });
    m.listMessages.mockResolvedValue({ messages: [{ id: "m1", role: "user" }], has_more: true });

    const req = new NextRequest("http://localhost/api/conversations/c1/init");
    const res = await GET(req, { params: { id: "c1" } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation).toEqual({ id: "c1" });
    expect(body.messages).toEqual([{ id: "m1" }]);
    expect(body.has_more_messages).toBe(true);
    expect(body.cache_valid).toBe(false);
  });

  it("preloads error task messages (workspace-scoped) for a running active task", async () => {
    m.getConversation.mockResolvedValue({ id: "c1", agentId: "a1", channel: null, userId: "u1" });
    m.getActiveTaskByConversation.mockResolvedValue({ id: "t1", status: "running" });
    // The query filters to type:"error" in SQL, so the route maps whatever it returns.
    m.listTaskErrorMessages.mockResolvedValue([
      { id: "tm2", seq: 2, type: "error", content: "boom" },
    ]);

    const req = new NextRequest("http://localhost/api/conversations/c1/init");
    const res = await GET(req, { params: { id: "c1" } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.task_messages).toEqual([{ id: "tm2" }]);
    // Scoped to the authed workspace and the active task.
    expect(m.listTaskErrorMessages).toHaveBeenCalledWith(expect.anything(), "t1", "w1");
  });

  it("does not query task errors when there is no active task", async () => {
    // A run that ended in error is settled to status:"failed" and re-surfaces via
    // its persisted assistant error message (not through this preload).
    m.getConversation.mockResolvedValue({ id: "c1", agentId: "a1", channel: null, userId: "u1" });
    m.getActiveTaskByConversation.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/conversations/c1/init");
    const res = await GET(req, { params: { id: "c1" } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.task_messages).toEqual([]);
    expect(m.listTaskErrorMessages).not.toHaveBeenCalled();
  });

  it("returns cache_valid=true and null messages when client cache matches", async () => {
    m.getConversation.mockResolvedValue({ id: "c1", agentId: "a1", channel: null, userId: "u1" });
    m.getNewestMessageId.mockResolvedValue("m9");
    m.getActiveMessageCount.mockResolvedValue(5);
    m.listMessages.mockResolvedValue({ messages: [{ id: "m9", role: "user" }], has_more: false });

    const req = new NextRequest(
      "http://localhost/api/conversations/c1/init?newest_message_id=m9&message_count=5",
    );
    const res = await GET(req, { params: { id: "c1" } });
    const body = await res.json();

    expect(body.cache_valid).toBe(true);
    expect(body.messages).toBeNull();
  });
});

// helper: confirm the conversation lookup was scoped to the authed workspace
function mockScoped() {
  return m.getConversation.mock.calls.every((c) => c[2] === "w1");
}
