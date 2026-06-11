import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListActiveTaskCountsByWorkspace = vi.fn();
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
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: any, _ttl: any, fn: any) => fn()),
  cacheKeys: {
    activeTaskCounts: (ws: string) => `atc:${ws}`,
    allAgents: (ws: string) => `agents:${ws}`,
    allAgentAccess: (ws: string) => `aa:${ws}`,
  },
}));
vi.mock("@alook/shared", () => ({
  queries: {
    task: {
      listActiveTaskCountsByWorkspace: (...args: any[]) =>
        mockListActiveTaskCountsByWorkspace(...args),
    },
    agent: {
      getAllAgentsForWorkspace: (...args: any[]) =>
        mockGetAllAgentsForWorkspace(...args),
    },
    agentAccess: {
      getAllAgentAccessForWorkspace: (...args: any[]) =>
        mockGetAllAgentAccessForWorkspace(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/agent-visibility", () => ({
  filterVisibleAgents: vi.fn(() => [{ id: "ag1" }]),
}));

import { GET } from "./route";

describe("GET /api/agents/active-task-counts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct counts per agent", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([{ id: "ag1" }]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);
    mockListActiveTaskCountsByWorkspace.mockResolvedValue([
      { agentId: "ag1", count: 3 },
    ]);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/active-task-counts"),
      {}
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ counts: { ag1: 3 } });
    expect(mockListActiveTaskCountsByWorkspace).toHaveBeenCalledWith({}, "w1", ["ag1"]);
  });

  it("returns empty counts when no active tasks", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([{ id: "ag1" }]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);
    mockListActiveTaskCountsByWorkspace.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/active-task-counts"),
      {}
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ counts: {} });
  });
});
