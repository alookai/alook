import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockGetOrCreateAgentConversation = vi.fn();
const mockListMessages = vi.fn();
const mockListArtifactsByConversation = vi.fn();
const mockListBufferedMessages = vi.fn();
const mockGetActiveTaskByConversation = vi.fn();
const mockListTaskMessages = vi.fn();
const mockArtifactToResponse = vi.fn((r: any) => ({
  id: r.id,
  conversation_id: r.conversationId,
  agent_id: r.agentId,
  filename: r.filename,
  content_type: r.contentType,
  size: r.size,
  source: r.source,
  created_at: r.createdAt,
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
    },
    conversation: {
      getOrCreateAgentConversation: (...args: unknown[]) =>
        mockGetOrCreateAgentConversation(...args),
    },
    message: {
      listMessages: (...args: unknown[]) => mockListMessages(...args),
      listBufferedMessages: (...args: unknown[]) =>
        mockListBufferedMessages(...args),
    },
    artifact: {
      listArtifactsByConversation: (...args: unknown[]) =>
        mockListArtifactsByConversation(...args),
      artifactToResponse: (...args: unknown[]) =>
        mockArtifactToResponse(...args),
    },
    task: {
      getActiveTaskByConversation: (...args: unknown[]) =>
        mockGetActiveTaskByConversation(...args),
    },
    taskMessage: {
      listTaskMessages: (...args: unknown[]) =>
        mockListTaskMessages(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  conversationToResponse: vi.fn((c: any) => ({
    id: c.id,
    agent_id: c.agentId,
    title: c.title,
    created_at: c.createdAt,
  })),
  messageToResponse: vi.fn((m: any) => ({
    id: m.id,
    conversation_id: m.conversationId,
    role: m.role,
    content: m.content,
    task_id: m.taskId || null,
    attachment_ids: null,
    created_at: m.createdAt,
  })),
  taskToResponse: vi.fn((t: any) => ({
    id: t.id,
    status: t.status,
    agent_id: t.agentId,
    created_at: t.createdAt,
  })),
  taskMessageToResponse: vi.fn((m: any) => ({
    id: m.id,
    task_id: m.taskId,
    seq: m.seq,
    type: m.type,
    content: m.content,
  })),
}));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

const makeReq = () =>
  new NextRequest("http://localhost/api/agents/a1/chat-init", {
    method: "POST",
  });
const makeCtx = () => ({ params: Promise.resolve({ id: "a1" }) });

const CONV = {
  id: "c1",
  agentId: "a1",
  title: "Hello",
  createdAt: "2024-01-01T00:00:00.000Z",
};

function setupDefaults() {
  mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent" });
  mockGetOrCreateAgentConversation.mockResolvedValue(CONV);
  mockListMessages.mockResolvedValue([]);
  mockListArtifactsByConversation.mockResolvedValue([]);
  mockListBufferedMessages.mockResolvedValue([]);
  mockGetActiveTaskByConversation.mockResolvedValue(null);
}

describe("POST /api/agents/[id]/chat-init", () => {
  it("returns all chat data in a single response", async () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "hi",
      taskId: null,
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const artifact = {
      id: "art1",
      conversationId: "c1",
      agentId: "a1",
      filename: "test.png",
      contentType: "image/png",
      size: 100,
      source: "agent",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent" });
    mockGetOrCreateAgentConversation.mockResolvedValue(CONV);
    mockListMessages.mockResolvedValue([msg]);
    mockListArtifactsByConversation.mockResolvedValue([artifact]);
    mockListBufferedMessages.mockResolvedValue([]);
    mockGetActiveTaskByConversation.mockResolvedValue(null);

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation.id).toBe("c1");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe("m1");
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].id).toBe("art1");
    expect(body.buffered_messages).toEqual([]);
    expect(body.active_task).toBeNull();
    expect(body.task_messages).toEqual([]);
    expect(body.has_more_messages).toBe(false);
  });

  it("returns 404 for non-existent agent", async () => {
    mockGetAgent.mockResolvedValue(null);

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("includes active task and task messages when task is running", async () => {
    const task = {
      id: "t1",
      agentId: "a1",
      runtimeId: "r1",
      conversationId: "c1",
      workspaceId: "w1",
      prompt: "do stuff",
      status: "running",
      priority: 0,
      dispatchedAt: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const tmsg = {
      id: "tm1",
      taskId: "t1",
      seq: 1,
      type: "text",
      content: "working...",
    };

    setupDefaults();
    mockGetActiveTaskByConversation.mockResolvedValue(task);
    mockListTaskMessages.mockResolvedValue([tmsg]);

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(body.active_task).not.toBeNull();
    expect(body.active_task.id).toBe("t1");
    expect(body.task_messages).toHaveLength(1);
    expect(body.task_messages[0].seq).toBe(1);
  });

  it("skips task messages for completed tasks", async () => {
    const task = {
      id: "t1",
      agentId: "a1",
      runtimeId: "r1",
      conversationId: "c1",
      workspaceId: "w1",
      prompt: "do stuff",
      status: "completed",
      priority: 0,
      dispatchedAt: null,
      startedAt: null,
      completedAt: "2024-01-01T00:01:00.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    setupDefaults();
    mockGetActiveTaskByConversation.mockResolvedValue(task);

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(body.active_task.id).toBe("t1");
    expect(body.task_messages).toEqual([]);
    expect(mockListTaskMessages).not.toHaveBeenCalled();
  });

  it("sets has_more_messages true when messages reach limit", async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      conversationId: "c1",
      role: "user",
      content: `msg ${i}`,
      taskId: null,
      createdAt: "2024-01-01T00:00:00.000Z",
    }));

    setupDefaults();
    mockListMessages.mockResolvedValue(msgs);

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(body.has_more_messages).toBe(true);
    expect(body.messages).toHaveLength(20);
  });

  it("returns empty state for new conversation", async () => {
    setupDefaults();

    const res = await POST(makeReq(), makeCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messages).toEqual([]);
    expect(body.artifacts).toEqual([]);
    expect(body.buffered_messages).toEqual([]);
    expect(body.active_task).toBeNull();
    expect(body.has_more_messages).toBe(false);
  });
});
