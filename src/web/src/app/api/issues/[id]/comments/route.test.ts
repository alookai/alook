import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetIssue = vi.fn();
const mockUpdateIssue = vi.fn();
const mockSetLatestTask = vi.fn();
const mockListComments = vi.fn();
const mockCreateComment = vi.fn();
const mockCommentToResponse = vi.fn((c: any) => ({
  id: c.id,
  content: c.content,
  author_type: c.authorType,
  author_id: c.authorId,
  created_at: c.createdAt ?? "2026-01-01T00:00:00Z",
}));
const mockGetActiveTaskByConversation = vi.fn();
const mockGetTask = vi.fn();
const mockCreateTask = vi.fn();
const mockGetAgent = vi.fn();
const mockEnqueueTask = vi.fn();
const mockBroadcastToUser = vi.fn().mockResolvedValue(undefined);
const mockInvalidate = vi.fn().mockResolvedValue(undefined);
const mockIsTerminalIssueStatus = vi.fn(() => false);

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  CreateIssueCommentBodySchema: { parse: vi.fn((data: any) => data) },
  TASK_TYPES: { ISSUE_EVENT: "issue_event" },
  isTerminalIssueStatus: (...args: unknown[]) => mockIsTerminalIssueStatus(...args),
  queries: {
    issue: {
      getIssue: (...a: unknown[]) => mockGetIssue(...a),
      updateIssue: (...a: unknown[]) => mockUpdateIssue(...a),
      setLatestTask: (...a: unknown[]) => mockSetLatestTask(...a),
    },
    issueComment: {
      listComments: (...a: unknown[]) => mockListComments(...a),
      createComment: (...a: unknown[]) => mockCreateComment(...a),
      commentToResponse: (...a: unknown[]) => mockCommentToResponse(...a),
    },
    task: {
      getActiveTaskByConversation: (...a: unknown[]) => mockGetActiveTaskByConversation(...a),
      getTask: (...a: unknown[]) => mockGetTask(...a),
      createTask: (...a: unknown[]) => mockCreateTask(...a),
    },
    agent: {
      getAgent: (...a: unknown[]) => mockGetAgent(...a),
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

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    parseBody: vi.fn(async (req: any) => {
      const body = await req.json();
      return [body, null];
    }),
  };
});

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}));

vi.mock("@/lib/services/task", () => ({
  TaskService: class {
    enqueueTask(...args: any[]) {
      return mockEnqueueTask(...args);
    }
  },
}));

vi.mock("@/lib/cache", () => ({
  invalidate: (...a: unknown[]) => mockInvalidate(...a),
  cacheKeys: { overviewTaskStats: vi.fn(() => "test-key") },
}));

import { GET, POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/issues/[id]/comments", () => {
  it("returns 400 when id is missing", async () => {
    const req = new NextRequest("http://localhost/api/issues//comments");
    const res = await GET(req, { params: {} } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "issue id is required" });
  });

  it("returns 404 when issue not found", async () => {
    mockGetIssue.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/issues/iss_1/comments");
    const res = await GET(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "issue not found" });
  });

  it("returns comments for the issue", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo" });
    mockListComments.mockResolvedValue([
      { id: "c1", content: "Hello", authorType: "user", authorId: "u1", createdAt: "2026-01-01T00:00:00Z" },
      { id: "c2", content: "World", authorType: "agent", authorId: "a1", createdAt: "2026-01-01T01:00:00Z" },
    ]);

    const req = new NextRequest("http://localhost/api/issues/iss_1/comments");
    const res = await GET(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0]).toEqual({ id: "c1", content: "Hello", author_type: "user", author_id: "u1", created_at: "2026-01-01T00:00:00Z" });
    expect(mockListComments).toHaveBeenCalledWith({}, "iss_1", "w1");
  });
});

describe("POST /api/issues/[id]/comments", () => {
  it("returns 400 when id is missing", async () => {
    const req = new NextRequest("http://localhost/api/issues//comments", {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await POST(req, { params: {} } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "issue id is required" });
  });

  it("returns 404 when issue not found", async () => {
    mockGetIssue.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/issues/iss_1/comments", {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "issue not found" });
  });

  it("returns 403 when agentId does not match issue", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", agentId: "a1", status: "todo" });
    const req = new NextRequest("http://localhost/api/issues/iss_1/comments?agentId=a_other", {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "issue does not belong to agent" });
  });

  it("creates a user comment without re-dispatch when status is terminal", async () => {
    mockIsTerminalIssueStatus.mockReturnValue(true);
    mockGetIssue.mockResolvedValue({
      id: "iss_1", agentId: "a1", status: "done", conversationId: "conv_1", creatorUserId: "u1",
    });
    mockCreateComment.mockResolvedValue({
      id: "ic_1", issueId: "iss_1", workspaceId: "w1", authorType: "user", authorId: "u1", content: "Nice", createdAt: "2026-01-01T00:00:00Z",
    });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1" });

    const req = new NextRequest("http://localhost/api/issues/iss_1/comments", {
      method: "POST",
      body: JSON.stringify({ content: "Nice" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment).toEqual({ id: "ic_1", content: "Nice", author_type: "user", author_id: "u1", created_at: "2026-01-01T00:00:00Z" });
    expect(mockCreateComment).toHaveBeenCalledWith({}, expect.objectContaining({ issueId: "iss_1", authorType: "user", authorId: "u1", content: "Nice" }));
    expect(mockUpdateIssue).toHaveBeenCalledWith({}, "iss_1", "w1", {});
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "issue.comment", issueId: "iss_1" }));
    // Should NOT trigger re-dispatch because status is terminal
    expect(mockGetActiveTaskByConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("creates a user comment and triggers re-dispatch when non-terminal and no active task", async () => {
    mockIsTerminalIssueStatus.mockReturnValue(false);
    mockGetIssue.mockResolvedValue({
      id: "iss_1", agentId: "a1", status: "in_progress", conversationId: "conv_1", creatorUserId: "u1", latestTaskId: "t_prev", title: "Fix bug",
    });
    mockCreateComment.mockResolvedValue({
      id: "ic_2", issueId: "iss_1", workspaceId: "w1", authorType: "user", authorId: "u1", content: "Please retry", createdAt: "2026-01-02T00:00:00Z",
    });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1" });
    mockGetActiveTaskByConversation.mockResolvedValue(null);
    mockGetTask.mockResolvedValue({ id: "t_prev", traceId: "trace_1" });
    mockEnqueueTask.mockResolvedValue({ id: "t_new" });
    mockSetLatestTask.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/issues/iss_1/comments", {
      method: "POST",
      body: JSON.stringify({ content: "Please retry" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);

    expect(res.status).toBe(201);
    expect(mockGetActiveTaskByConversation).toHaveBeenCalledWith({}, "conv_1", "w1");
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_1", "w1",
      expect.stringContaining("Please retry"),
      "issue_event",
      expect.objectContaining({ contextKey: "conv_1", context: { issue_id: "iss_1" }, traceId: "trace_1" }),
    );
    expect(mockSetLatestTask).toHaveBeenCalledWith({}, "iss_1", "w1", "t_new");
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("creates an agent comment without re-dispatch", async () => {
    mockIsTerminalIssueStatus.mockReturnValue(false);
    mockGetIssue.mockResolvedValue({
      id: "iss_1", agentId: "a1", status: "in_progress", conversationId: "conv_1", creatorUserId: "u1",
    });
    mockCreateComment.mockResolvedValue({
      id: "ic_3", issueId: "iss_1", workspaceId: "w1", authorType: "agent", authorId: "a1", content: "Working on it", createdAt: "2026-01-03T00:00:00Z",
    });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1" });

    const req = new NextRequest("http://localhost/api/issues/iss_1/comments?agentId=a1", {
      method: "POST",
      body: JSON.stringify({ content: "Working on it" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment.author_type).toBe("agent");
    expect(body.comment.author_id).toBe("a1");
    expect(mockCreateComment).toHaveBeenCalledWith({}, expect.objectContaining({ authorType: "agent", authorId: "a1" }));
    // Agent comments should NOT trigger re-dispatch
    expect(mockGetActiveTaskByConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
