import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockCreateConversation = vi.fn();
const mockListBranchesByParent = vi.fn();
const mockGetBranchForRoot = vi.fn();
const mockCreateBranch = vi.fn();
const mockGetMessageForConversation = vi.fn();
const mockGetLatestBranchableMessage = vi.fn();
const mockGetLatestCompletedTaskWithSessionForConversation = vi.fn();
const mockGetAgent = vi.fn();
const mockGetRuntime = vi.fn();
const mockGetTask = vi.fn();

const mockConversationBranchToResponse = vi.fn((b: any) => ({
  id: b.id,
  root_message_id: b.rootMessageId,
  branch_conversation_id: b.branchConversationId,
  provider: b.provider,
  fork_source_task_id: b.forkSourceTaskId ?? null,
  fork_source_session_id: b.forkSourceSessionId ?? null,
}));
const mockConversationToResponse = vi.fn((c: any) => ({
  id: c.id,
  type: c.type,
  title: c.title,
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
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
  conversationBranchToResponse: (...args: any[]) =>
    mockConversationBranchToResponse(...args),
  conversationToResponse: (...args: any[]) => mockConversationToResponse(...args),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    CONVERSATION_TYPES: {
      USER_DM_MESSAGE: "user_dm_message",
      MESSAGE_BRANCH: "message_branch",
    },
    queries: {
      conversation: {
        getConversation: (...args: any[]) => mockGetConversation(...args),
        createConversation: (...args: any[]) =>
          mockCreateConversation(...args),
      },
      conversationBranch: {
        listBranchesByParent: (...args: any[]) =>
          mockListBranchesByParent(...args),
        getBranchForRoot: (...args: any[]) => mockGetBranchForRoot(...args),
        createBranch: (...args: any[]) => mockCreateBranch(...args),
      },
      message: {
        isBranchableMessageRoot: (...args: any[]) =>
          (actual as any).queries.message.isBranchableMessageRoot(...args),
        getMessageForConversation: (...args: any[]) =>
          mockGetMessageForConversation(...args),
        getLatestBranchableMessage: (...args: any[]) =>
          mockGetLatestBranchableMessage(...args),
      },
      agent: {
        getAgent: (...args: any[]) => mockGetAgent(...args),
      },
      runtime: {
        getAgentRuntimeForWorkspace: (...args: any[]) => mockGetRuntime(...args),
      },
      task: {
        getLatestCompletedTaskWithSessionForConversation: (...args: any[]) =>
          mockGetLatestCompletedTaskWithSessionForConversation(...args),
        getTask: (...args: any[]) => mockGetTask(...args),
      },
    },
  };
});

import { GET, POST } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });
const parentConversation = {
  id: "parent_c",
  workspaceId: "w1",
  userId: "u1",
  agentId: "a1",
  title: "Parent",
  type: "user_dm_message",
  channel: "default",
};

describe("/api/conversations/[id]/branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists branches for an owned parent conversation", async () => {
    mockGetConversation.mockResolvedValue(parentConversation);
    mockListBranchesByParent.mockResolvedValue([
      {
        id: "br_1",
        rootMessageId: "m1",
        branchConversationId: "branch_c",
        provider: "claude",
      },
    ]);

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/parent_c/branches"),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.branches).toEqual([
      {
        id: "br_1",
        root_message_id: "m1",
        branch_conversation_id: "branch_c",
        provider: "claude",
        fork_source_task_id: null,
        fork_source_session_id: null,
      },
    ]);
    expect(mockListBranchesByParent).toHaveBeenCalledWith({}, {
      workspaceId: "w1",
      parentConversationId: "parent_c",
    });
  });

  it("reuses an existing branch conversation for the same root message", async () => {
    const branch = {
      id: "br_1",
      rootMessageId: "m1",
      branchConversationId: "branch_c",
      provider: "claude",
    };
    const branchConversation = {
      id: "branch_c",
      title: "Parent",
      type: "message_branch",
    };
    mockGetConversation
      .mockResolvedValueOnce(parentConversation)
      .mockResolvedValueOnce(branchConversation);
    mockGetMessageForConversation.mockResolvedValue({
      id: "m1",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      metadata: { kind: "dm" },
    });
    mockGetBranchForRoot.mockResolvedValue(branch);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m1" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation.id).toBe("branch_c");
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  it("rejects a transient root before reusing an existing branch row", async () => {
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetMessageForConversation.mockResolvedValue({
      id: "m_process",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      metadata: { kind: "process", transient: true },
    });
    mockGetBranchForRoot.mockResolvedValue({
      id: "br_bad",
      rootMessageId: "m_process",
      branchConversationId: "branch_c",
      provider: "codex",
    });

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_process" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("root message cannot be branched");
    expect(mockGetBranchForRoot).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  it("creates a branch for the latest completed branchable message on a supported runtime", async () => {
    const rootMessage = {
      id: "m_latest",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      taskId: "root_task",
      metadata: { kind: "dm" },
    };
    const branchConversation = {
      id: "branch_c",
      title: "Parent",
      type: "message_branch",
    };
    const branch = {
      id: "br_1",
      rootMessageId: "m_latest",
      branchConversationId: "branch_c",
      provider: "codex",
      forkSourceTaskId: "root_task",
      forkSourceSessionId: "root_session",
    };
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetBranchForRoot.mockResolvedValue(null);
    mockGetMessageForConversation.mockResolvedValue(rootMessage);
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetLatestCompletedTaskWithSessionForConversation.mockResolvedValue({
      id: "root_task",
      runtimeId: "rt1",
      sessionId: "root_session",
    });
    mockGetRuntime.mockResolvedValue({ id: "rt1", provider: "codex" });
    mockCreateConversation.mockResolvedValue(branchConversation);
    mockCreateBranch.mockResolvedValue(branch);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_latest" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.branch.provider).toBe("codex");
    expect(mockCreateConversation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        type: "message_branch",
        agentId: "a1",
        userId: "u1",
      }),
    );
    expect(mockCreateBranch).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        parentConversationId: "parent_c",
        branchConversationId: "branch_c",
        rootMessageId: "m_latest",
        provider: "codex",
        forkSourceTaskId: "root_task",
        forkSourceSessionId: "root_session",
      }),
    );
  });

  it("rejects branch creation when no completed fork source session exists", async () => {
    const rootMessage = {
      id: "m_latest",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      metadata: { kind: "dm" },
    };
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetBranchForRoot.mockResolvedValue(null);
    mockGetMessageForConversation.mockResolvedValue(rootMessage);
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetLatestCompletedTaskWithSessionForConversation.mockResolvedValue(null);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_latest" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("branch fork source session is not available");
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  it("creates a branch from the previous completed message while the parent conversation has an active task", async () => {
    const rootMessage = {
      id: "m_previous_completed",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      taskId: "root_task",
      metadata: { kind: "dm" },
    };
    const branchConversation = {
      id: "branch_c",
      title: "Parent",
      type: "message_branch",
    };
    const branch = {
      id: "br_1",
      rootMessageId: "m_previous_completed",
      branchConversationId: "branch_c",
      provider: "claude",
      forkSourceTaskId: "latest_done_task",
      forkSourceSessionId: "latest_done_session",
    };
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetBranchForRoot.mockResolvedValue(null);
    mockGetMessageForConversation.mockResolvedValue(rootMessage);
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetLatestCompletedTaskWithSessionForConversation.mockResolvedValue({
      id: "latest_done_task",
      runtimeId: "rt1",
      sessionId: "latest_done_session",
    });
    mockGetRuntime.mockResolvedValue({ id: "rt1", provider: "claude" });
    mockCreateConversation.mockResolvedValue(branchConversation);
    mockCreateBranch.mockResolvedValue(branch);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_previous_completed" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.branch.root_message_id).toBe("m_previous_completed");
    expect(mockCreateBranch).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rootMessageId: "m_previous_completed",
        provider: "claude",
        forkSourceTaskId: "latest_done_task",
        forkSourceSessionId: "latest_done_session",
      }),
    );
  });

  it("rejects transient process roots even if stale UI sends one", async () => {
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetBranchForRoot.mockResolvedValue(null);
    mockGetMessageForConversation.mockResolvedValue({
      id: "m_process",
      conversationId: "parent_c",
      role: "assistant",
      status: "active",
      metadata: JSON.stringify({ kind: "process", transient: true }),
    });

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_process" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("root message cannot be branched");
    expect(mockGetLatestBranchableMessage).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  it("creates a branch for an older user message using the latest completed fork source", async () => {
    const branchConversation = {
      id: "branch_c",
      title: "Parent",
      type: "message_branch",
    };
    const branch = {
      id: "br_1",
      rootMessageId: "m_old",
      branchConversationId: "branch_c",
      provider: "codex",
      forkSourceTaskId: "latest_done_task",
      forkSourceSessionId: "latest_done_session",
    };
    mockGetConversation.mockResolvedValue(parentConversation);
    mockGetBranchForRoot.mockResolvedValue(null);
    mockGetMessageForConversation.mockResolvedValue({
      id: "m_old",
      conversationId: "parent_c",
      role: "user",
      status: "active",
    });
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetLatestCompletedTaskWithSessionForConversation.mockResolvedValue({
      id: "latest_done_task",
      runtimeId: "rt1",
      sessionId: "latest_done_session",
    });
    mockGetRuntime.mockResolvedValue({ id: "rt1", provider: "codex" });
    mockCreateConversation.mockResolvedValue(branchConversation);
    mockCreateBranch.mockResolvedValue(branch);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/parent_c/branches", {
        method: "POST",
        body: JSON.stringify({ root_message_id: "m_old" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.branch.root_message_id).toBe("m_old");
    expect(body.branch.fork_source_task_id).toBe("latest_done_task");
    expect(mockCreateBranch).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rootMessageId: "m_old",
        forkSourceTaskId: "latest_done_task",
        forkSourceSessionId: "latest_done_session",
      }),
    );
  });
});
