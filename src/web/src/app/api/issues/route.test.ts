import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockListIssues = vi.fn();
const mockCreateConversation = vi.fn();
const mockCreateIssue = vi.fn();
const mockCreateMessage = vi.fn();
const mockSetLatestTask = vi.fn();
const mockEnqueueTask = vi.fn();
const mockCreateArtifact = vi.fn();
const mockR2Put = vi.fn();
const mockGetTraceAgentsByTaskIds = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: { put: (...a: unknown[]) => mockR2Put(...a) },
    },
  })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
      task: { getTraceAgentsByTaskIds: (...a: unknown[]) => mockGetTraceAgentsByTaskIds(...a) },
      issue: {
        listIssues: (...a: unknown[]) => mockListIssues(...a),
        createIssue: (...a: unknown[]) => mockCreateIssue(...a),
        setLatestTask: (...a: unknown[]) => mockSetLatestTask(...a),
      },
      conversation: { createConversation: (...a: unknown[]) => mockCreateConversation(...a) },
      message: { createMessage: (...a: unknown[]) => mockCreateMessage(...a), updateMessageTaskId: vi.fn().mockResolvedValue(undefined) },
      artifact: { createArtifact: (...a: unknown[]) => mockCreateArtifact(...a) },
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

vi.mock("@/lib/services/task", () => ({
  TaskService: function () {
    return { enqueueTask: mockEnqueueTask };
  },
}));

vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn(() => Promise.resolve()) }));

vi.mock("@/lib/api/responses", () => ({
  issueToResponse: (i: any) => ({ id: i.id, agent_id: i.agentId, title: i.title, status: i.status }),
  messageToResponse: (m: any) => ({ id: m.id, content: m.content }),
  taskToResponse: (t: any) => ({ id: t.id, type: t.type }),
}));

import { GET, POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/issues", () => {
  it("lists workspace issues with filters", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    mockListIssues.mockResolvedValue([{ id: "iss_1", agentId: "ag_1", title: "Fix", status: "todo" }]);
    mockGetTraceAgentsByTaskIds.mockResolvedValue(new Map());
    const res = await GET(new NextRequest("http://localhost/api/issues?agentId=ag_1&terminal=false"), {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "iss_1", agent_id: "ag_1", title: "Fix", status: "todo", thread_agent_ids: [] }]);
    expect(mockListIssues).toHaveBeenCalledWith({}, "w1", { userId: "u1", agentId: "ag_1", status: undefined, terminal: false });
  });

  it("rejects invalid status", async () => {
    const res = await GET(new NextRequest("http://localhost/api/issues?status=bad"), {} as any);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues", () => {
  it("creates issue conversation and dispatches issue task", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1", ownerId: "u1", runtimeId: "rt1" });
    mockCreateConversation.mockResolvedValue({ id: "c1" });
    mockCreateIssue.mockResolvedValue({ id: "iss_1", agentId: "ag_1", title: "Fix", description: "Body", status: "todo", conversationId: "c1" });
    mockCreateMessage.mockResolvedValue({ id: "m1", content: "Issue created: Fix" });
    mockEnqueueTask.mockResolvedValue({ id: "t1", agentId: "ag_1", type: "issue_event" });
    mockSetLatestTask.mockResolvedValue({ id: "iss_1", agentId: "ag_1", title: "Fix", description: "Body", status: "todo", conversationId: "c1", latestTaskId: "t1" });

    const req = new NextRequest("http://localhost/api/issues", {
      method: "POST",
      body: JSON.stringify({ agent_id: "ag_1", title: "Fix", description: "Body" }),
    });
    const res = await POST(req, {} as any);
    expect(res.status).toBe(201);
    expect(mockCreateConversation).toHaveBeenCalledWith({}, expect.objectContaining({ type: "issue_event", agentId: "ag_1" }));
    expect(mockEnqueueTask).toHaveBeenCalledWith("ag_1", "c1", "w1", expect.stringContaining("Fix"), "issue_event", expect.objectContaining({ contextKey: "c1" }));
  });

  it("uploads attachments and includes attachment ids in the issue task context", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1", ownerId: "u1", runtimeId: "rt1" });
    mockCreateConversation.mockResolvedValue({ id: "c1" });
    mockCreateIssue.mockResolvedValue({ id: "iss_1", agentId: "ag_1", title: "Fix", description: "Body", status: "todo", conversationId: "c1" });
    mockCreateMessage.mockResolvedValue({ id: "m1", content: "Issue created: Fix", attachmentIds: '["art_1"]' });
    mockCreateArtifact.mockResolvedValue({ id: "art_1" });
    mockR2Put.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({ id: "t1", agentId: "ag_1", type: "issue_event" });
    mockSetLatestTask.mockResolvedValue({ id: "iss_1", agentId: "ag_1", title: "Fix", description: "Body", status: "todo", conversationId: "c1", latestTaskId: "t1" });

    const formData = new FormData();
    formData.append("agent_id", "ag_1");
    formData.append("title", "Fix");
    formData.append("description", "Body");
    formData.append("file", new File(["hello"], "note.md", { type: "text/markdown" }));

    const req = new NextRequest("http://localhost/api/issues", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(mockR2Put).toHaveBeenCalledTimes(1);
    expect(mockCreateArtifact).toHaveBeenCalledWith({}, expect.objectContaining({
      conversationId: "c1",
      agentId: "ag_1",
      workspaceId: "w1",
      filename: "note.md",
      contentType: "text/markdown",
      size: 5,
      source: "attachment",
    }));
    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      attachmentIds: expect.stringContaining("art_"),
    }));
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "ag_1",
      "c1",
      "w1",
      expect.stringContaining("Fix"),
      "issue_event",
      expect.objectContaining({
        contextKey: "c1",
        context: expect.objectContaining({
          issue_id: "iss_1",
          attachment_ids: [expect.stringContaining("art_")],
        }),
      }),
    );
  });
});
