import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListTraces = vi.fn();
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
      listTraces: (...args: any[]) => mockListTraces(...args),
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

describe("GET /api/traces", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns traces with agent info mapped", async () => {
    mockListTraces.mockResolvedValue({
      traces: [
        {
          traceId: "tr_abc",
          rootPrompt: "Hello",
          rootAgentId: "a1",
          helperAgentIds: ["a2"],
          status: "completed",
          taskCount: 2,
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:01:00Z",
          channel: "default",
        },
      ],
      hasMore: false,
    });
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", name: "Agent 1", avatarUrl: "https://img/a1.png" },
      { id: "a2", name: "Agent 2", avatarUrl: "https://img/a2.png" },
    ]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/traces"), {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]).toEqual({
      trace_id: "tr_abc",
      root_prompt: "Hello",
      root_agent_id: "a1",
      root_agent: { name: "Agent 1", avatarUrl: "https://img/a1.png" },
      helper_agents: [{ id: "a2", name: "Agent 2", avatarUrl: "https://img/a2.png" }],
      status: "completed",
      task_count: 2,
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      channel: "default",
    });
    expect(body.has_more).toBe(false);
  });

  it("filters out traces whose root agent is not visible", async () => {
    mockListTraces.mockResolvedValue({
      traces: [
        {
          traceId: "tr_xyz",
          rootPrompt: "Test",
          rootAgentId: "unknown_agent",
          helperAgentIds: [],
          status: "active",
          taskCount: 1,
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
          channel: "email",
        },
      ],
      hasMore: false,
    });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/traces"), {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.traces).toHaveLength(0);
  });

  it("respects status filter", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces?status=failed"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("ignores invalid status filter", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces?status=invalid"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ status: undefined }),
    );
  });

  it("default limit behavior", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("clamps limit to 1-100 range", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces?limit=200"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("multiAgent filter", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces?multiAgent=true"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ multiAgent: true }),
    );
  });

  it("passes agentId and channel filters", async () => {
    mockListTraces.mockResolvedValue({ traces: [], hasMore: false });
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);

    await GET(new NextRequest("http://localhost/api/traces?agentId=a1&channel=email"), {});

    expect(mockListTraces).toHaveBeenCalledWith(
      {},
      "w1",
      expect.objectContaining({ agentId: "a1", channel: "email" }),
    );
  });
});
