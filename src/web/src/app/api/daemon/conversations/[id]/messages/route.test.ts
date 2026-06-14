import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const m = {
  getConversation: vi.fn(),
  createMessage: vi.fn(),
  updateConversationTitle: vi.fn(),
  updateUnreadLatestMessage: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      conversation: {
        getConversation: (...a: unknown[]) => m.getConversation(...a),
        updateConversationTitle: (...a: unknown[]) => m.updateConversationTitle(...a),
      },
      message: {
        createMessage: (...a: unknown[]) => m.createMessage(...a),
      },
      inbox: {
        updateUnreadLatestMessage: (...a: unknown[]) => m.updateUnreadLatestMessage(...a),
      },
    },
  };
});

// Faithful auth realm: a machine token (al_...) sets ctx.workspaceId; a user
// session/JWT does NOT. This lets us exercise the route's 403 daemon-only guard.
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    const auth = (req.headers?.get?.("Authorization") as string) || "";
    const isMachine = auth.startsWith("Bearer al_");
    return handler(req, {
      env: { DB: {} },
      userId: "u1",
      email: "u@t.com",
      workspaceId: isMachine ? "w1" : undefined,
      params,
    });
  }),
}));

const broadcastToUser = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => broadcastToUser(...a),
}));
vi.mock("@/lib/api/responses", () => ({
  messageToResponse: (msg: any) => ({ id: msg.id, content: msg.content, role: msg.role }),
}));

import { POST } from "./route";

function makeReq(body: unknown, opts?: { machine?: boolean }) {
  return new NextRequest("http://localhost/api/daemon/conversations/c1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: opts?.machine === false ? "Bearer session-jwt" : "Bearer al_token",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getConversation.mockResolvedValue({ id: "c1", workspaceId: "w1", userId: "owner-1" });
  m.createMessage.mockImplementation((_db: unknown, data: any) => ({
    id: "msg-1",
    ...data,
  }));
  m.updateConversationTitle.mockResolvedValue(null);
});

describe("POST /api/daemon/conversations/[id]/messages", () => {
  // TC1
  it("creates one role:assistant message with taskId + metadata.kind=dm and broadcasts (201)", async () => {
    const res = await POST(makeReq({ content: "hello", task_id: "t1" }), { params: { id: "c1" } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.content).toBe("hello");

    expect(m.createMessage).toHaveBeenCalledTimes(1);
    const [, data] = m.createMessage.mock.calls[0];
    expect(data.role).toBe("assistant");
    expect(data.content).toBe("hello");
    expect(data.taskId).toBe("t1");
    expect(JSON.parse(data.metadata)).toEqual({ kind: "dm" });

    // Broadcast targets the conversation owner, not the token owner.
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    const [target, payload] = broadcastToUser.mock.calls[0];
    expect(target).toBe("owner-1");
    expect(payload.type).toBe("conversation.message");
    expect(payload.conversationId).toBe("c1");
  });

  it("auto-titles the conversation from the message content", async () => {
    await POST(makeReq({ content: "Summarize the backlog" }), { params: { id: "c1" } });
    expect(m.updateConversationTitle).toHaveBeenCalledWith({}, "c1", "Summarize the backlog");
  });

  it("does not require a task_id (taskId null)", async () => {
    const res = await POST(makeReq({ content: "no task" }), { params: { id: "c1" } });
    expect(res.status).toBe(201);
    const [, data] = m.createMessage.mock.calls[0];
    expect(data.taskId).toBeNull();
  });

  // TC4 — foreign-workspace conversation id → 404 (scoped-ahead, no leak)
  it("404 when conversation is not in the token's workspace", async () => {
    m.getConversation.mockResolvedValue(null);
    const res = await POST(makeReq({ content: "x" }), { params: { id: "other" } });
    expect(res.status).toBe(404);
    expect(m.createMessage).not.toHaveBeenCalled();
    expect(broadcastToUser).not.toHaveBeenCalled();
  });

  // TC5 — a user JWT (no workspaceId) → 403 daemon-only
  it("403 when called without a machine token (no workspaceId)", async () => {
    const res = await POST(makeReq({ content: "x" }, { machine: false }), { params: { id: "c1" } });
    expect(res.status).toBe(403);
    expect(m.getConversation).not.toHaveBeenCalled();
    expect(m.createMessage).not.toHaveBeenCalled();
  });

  // TC7 — empty content rejected by schema (min length)
  it("400 when content is empty (schema min length)", async () => {
    const res = await POST(makeReq({ content: "" }), { params: { id: "c1" } });
    expect(res.status).toBe(400);
    expect(m.createMessage).not.toHaveBeenCalled();
  });

  // TC6 — two sends in one task → two distinct rows, both broadcast
  it("supports multiple sends in one task (each is its own message + broadcast)", async () => {
    await POST(makeReq({ content: "on it", task_id: "t1" }), { params: { id: "c1" } });
    await POST(makeReq({ content: "done", task_id: "t1" }), { params: { id: "c1" } });
    expect(m.createMessage).toHaveBeenCalledTimes(2);
    expect(broadcastToUser).toHaveBeenCalledTimes(2);
    const first = m.createMessage.mock.calls[0][1];
    const second = m.createMessage.mock.calls[1][1];
    expect(first.taskId).toBe("t1");
    expect(second.taskId).toBe("t1");
    expect(first.content).toBe("on it");
    expect(second.content).toBe("done");
  });
});
