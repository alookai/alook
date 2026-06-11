import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTraceTree = vi.fn();
const mockGetConversation = vi.fn();
const mockGetAllAgentsForWorkspace = vi.fn();
const mockGetAllAgentAccessForWorkspace = vi.fn();

vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  writeError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@alook/shared", () => ({
  queries: {
    task: {
      getTraceTree: (...args: any[]) => mockGetTraceTree(...args),
    },
    conversation: {
      getConversation: (...args: any[]) => mockGetConversation(...args),
    },
    agent: {
      getAllAgentsForWorkspace: (...args: any[]) => mockGetAllAgentsForWorkspace(...args),
    },
    agentAccess: {
      getAllAgentAccessForWorkspace: (...args: any[]) => mockGetAllAgentAccessForWorkspace(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, fn: () => any) => fn()),
  cacheKeys: {
    allAgents: (ws: string) => `agents:${ws}`,
    allAgentAccess: (ws: string) => `aa:${ws}`,
  },
}));
vi.mock("@/lib/agent-visibility", () => ({
  filterVisibleAgents: vi.fn((agents: any[]) => agents),
}));

import { GET } from "./route";

describe("GET /api/traces/[traceId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for traceId without tr_ prefix", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/traces/invalid123"),
      { params: Promise.resolve({ traceId: "invalid123" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid traceId");
  });

  it("returns 400 for traceId that is too long", async () => {
    const longId = "tr_" + "a".repeat(28); // length 31 > 30
    const res = await GET(
      new NextRequest(`http://localhost/api/traces/${longId}`),
      { params: Promise.resolve({ traceId: longId }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid traceId");
  });

  it("returns 400 for missing traceId", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/traces/"),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid traceId");
  });

  it("returns 404 when trace not found (empty tasks)", async () => {
    mockGetTraceTree.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/traces/tr_abc123"),
      { params: Promise.resolve({ traceId: "tr_abc123" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("trace not found");
  });

  it("returns trace with tasks and agent mapping", async () => {
    mockGetTraceTree.mockResolvedValue([
      {
        id: "task_1",
        agentId: "a1",
        parentTaskId: null,
        prompt: "Root task",
        status: "completed",
        type: "user_dm_message",
        conversationId: "conv_1",
        createdAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
      },
      {
        id: "task_2",
        agentId: "a2",
        parentTaskId: "task_1",
        prompt: "Sub task",
        status: "completed",
        type: "email_notification",
        conversationId: "conv_1",
        createdAt: "2026-01-01T00:00:10Z",
        completedAt: "2026-01-01T00:00:50Z",
      },
    ]);
    mockGetConversation.mockResolvedValue({ channel: "slack" });
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", name: "Agent 1", emailHandle: "agent1", avatarUrl: "https://img/a1.png" },
      { id: "a2", name: "Agent 2", emailHandle: "agent2", avatarUrl: "https://img/a2.png" },
    ]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/traces/tr_abc123"),
      { params: Promise.resolve({ traceId: "tr_abc123" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.trace_id).toBe("tr_abc123");
    expect(body.channel).toBe("slack");
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]).toEqual({
      id: "task_1",
      agent_id: "a1",
      agent: { name: "Agent 1", email_handle: "agent1", avatarUrl: "https://img/a1.png" },
      parent_task_id: null,
      prompt: "Root task",
      status: "completed",
      type: "user_dm_message",
      conversation_id: "conv_1",
      created_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
    });
    expect(body.tasks[1].agent).toEqual({
      name: "Agent 2",
      email_handle: "agent2",
      avatarUrl: "https://img/a2.png",
    });
  });

  it("returns default channel when no conversation found", async () => {
    mockGetTraceTree.mockResolvedValue([
      {
        id: "task_1",
        agentId: "a1",
        parentTaskId: null,
        prompt: "Root task",
        status: "active",
        type: "user_dm_message",
        conversationId: "conv_1",
        createdAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
    ]);
    mockGetConversation.mockResolvedValue(null);
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", name: "Agent 1", emailHandle: "agent1", avatarUrl: null },
    ]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/traces/tr_abc123"),
      { params: Promise.resolve({ traceId: "tr_abc123" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.channel).toBe("default");
  });

  it("returns 404 when root agent is not visible", async () => {
    mockGetTraceTree.mockResolvedValue([
      {
        id: "task_1",
        agentId: "unknown_agent",
        parentTaskId: null,
        prompt: "Root task",
        status: "active",
        type: "user_dm_message",
        conversationId: "conv_1",
        createdAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
    ]);
    mockGetConversation.mockResolvedValue({ channel: "default" });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/traces/tr_abc123"),
      { params: Promise.resolve({ traceId: "tr_abc123" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});
