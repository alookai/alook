import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetIssue = vi.fn();
const mockListIssueMessages = vi.fn();
const mockUpdateIssue = vi.fn();
const mockDeleteIssue = vi.fn();
const mockCreateMessage = vi.fn();
const mockListArtifactsByConversation = vi.fn();
const mockListComments = vi.fn();
const mockCreateComment = vi.fn();
const mockGetTask = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      issue: {
        getIssue: (...a: unknown[]) => mockGetIssue(...a),
        listIssueMessages: (...a: unknown[]) => mockListIssueMessages(...a),
        updateIssue: (...a: unknown[]) => mockUpdateIssue(...a),
        deleteIssue: (...a: unknown[]) => mockDeleteIssue(...a),
      },
      task: {
        getTask: (...a: unknown[]) => mockGetTask(...a),
      },
      message: { createMessage: (...a: unknown[]) => mockCreateMessage(...a) },
      issueComment: {
        listComments: (...a: unknown[]) => mockListComments(...a),
        createComment: (...a: unknown[]) => mockCreateComment(...a),
        commentToResponse: (c: any) => ({ id: c.id, content: c.content, author_type: c.authorType ?? "user", author_id: c.authorId ?? "u1", created_at: c.createdAt ?? new Date().toISOString() }),
      },
      artifact: {
        listArtifactsByConversation: (...a: unknown[]) => mockListArtifactsByConversation(...a),
        artifactToResponse: (a: any) => ({ id: a.id, filename: a.filename }),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  issueToResponse: (i: any) => ({ id: i.id, status: i.status, conversation_id: i.conversationId }),
  messageToResponse: (m: any) => ({ id: m.id, role: m.role, content: m.content }),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockBroadcastToUser = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}));

const mockCancelActiveTask = vi.fn();
const mockCancelTrace = vi.fn();
vi.mock("@/lib/services/task", () => ({
  TaskService: class {
    cancelActiveTask(...args: any[]) { return mockCancelActiveTask(...args); }
    cancelTrace(...args: any[]) { return mockCancelTrace(...args); }
  },
}));

import { GET, PATCH, POST, DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/issues/[id]", () => {
  it("returns issue and messages", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1" });
    mockListIssueMessages.mockResolvedValue([{ id: "m1", role: "event", content: "Created" }]);
    mockListComments.mockResolvedValue([]);
    mockListArtifactsByConversation.mockResolvedValue([{ id: "art_1", filename: "brief.md" }]);
    const res = await GET(new NextRequest("http://localhost/api/issues/iss_1"), { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issue: { id: "iss_1", status: "todo", conversation_id: "c1", trace_id: null },
      messages: [{ id: "m1", role: "event", content: "Created" }],
      comments: [],
      artifacts: [{ id: "art_1", filename: "brief.md" }],
    });
    expect(mockListArtifactsByConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });
});

describe("PATCH /api/issues/[id]", () => {
  it("updates status and records status transition", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1" });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1", status: "in_progress", conversationId: "c1" });
    mockCreateMessage.mockResolvedValue({ id: "m1", role: "event", content: "Issue status changed: todo -> in_progress" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress" }),
    });
    const res = await PATCH(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith({}, "iss_1", "w1", { title: undefined, description: undefined, status: "in_progress" });
    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "event", content: "Issue status changed: todo -> in_progress" }));
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "conversation.message", conversationId: "c1" }));
  });
});

describe("POST /api/issues/[id]", () => {
  it("adds a user comment for browser callers", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1", agentId: "a1" });
    mockCreateComment.mockResolvedValue({ id: "ic_1", issueId: "iss_1", workspaceId: "w1", authorType: "user", authorId: "u1", content: "Looks good", createdAt: "2026-01-01T00:00:00Z" });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", {
      method: "POST",
      body: JSON.stringify({ content: "Looks good" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith({}, expect.objectContaining({ issueId: "iss_1", content: "Looks good", authorType: "user" }));
  });
});

describe("DELETE /api/issues/[id]", () => {
  it("deletes the issue and returns 204", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", conversationId: "c1", latestTaskId: null });
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockDeleteIssue).toHaveBeenCalledWith({}, "iss_1", "w1");
    expect(mockCancelActiveTask).toHaveBeenCalledWith("c1", "w1", { reason: "Task cancelled: issue deleted" });
  });

  it("cancels via traceId when latestTask has a traceId", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", conversationId: "c1", latestTaskId: "t1" });
    mockGetTask.mockResolvedValue({ id: "t1", traceId: "trace_1" });
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockCancelTrace).toHaveBeenCalledWith("trace_1", "w1", { reason: "Task cancelled: issue deleted" });
    expect(mockCancelActiveTask).not.toHaveBeenCalled();
    expect(mockDeleteIssue).toHaveBeenCalled();
  });

  it("falls back to cancelActiveTask when latestTask has no traceId", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", conversationId: "c1", latestTaskId: "t1" });
    mockGetTask.mockResolvedValue({ id: "t1", traceId: null });
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockCancelActiveTask).toHaveBeenCalledWith("c1", "w1", { reason: "Task cancelled: issue deleted" });
    expect(mockCancelTrace).not.toHaveBeenCalled();
  });

  it("falls back to cancelActiveTask when latestTaskId exists but task row is missing", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", conversationId: "c1", latestTaskId: "t_gone" });
    mockGetTask.mockResolvedValue(null);
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockCancelActiveTask).toHaveBeenCalledWith("c1", "w1", { reason: "Task cancelled: issue deleted" });
    expect(mockCancelTrace).not.toHaveBeenCalled();
    expect(mockDeleteIssue).toHaveBeenCalled();
  });

  it("still deletes the issue when cancellation throws", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", conversationId: "c1", latestTaskId: null });
    mockCancelActiveTask.mockRejectedValue(new Error("cancel failed"));
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockDeleteIssue).toHaveBeenCalledWith({}, "iss_1", "w1");
  });

  it("returns 404 when issue does not exist", async () => {
    mockGetIssue.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/issues/iss_999", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_999" } } as any);
    expect(res.status).toBe(404);
  });
});
