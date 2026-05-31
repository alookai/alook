import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockListActive = vi.fn();
const mockGetAllAgents = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      task: { listActiveTasksByWorkspace: (...a: unknown[]) => mockListActive(...a) },
      agent: { getAllAgentsForWorkspace: (...a: unknown[]) => mockGetAllAgents(...a) },
      agentAccess: { getAllAgentAccessForWorkspace: vi.fn().mockResolvedValue([]) },
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
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_k: string, _t: number, fn: () => Promise<any>) => fn()),
  cacheKeys: { allAgents: (w: string) => `ag:${w}`, allAgentAccess: (w: string) => `aa:${w}` },
}));
vi.mock("@/lib/agent-visibility", () => ({ filterVisibleAgents: vi.fn((a: any[]) => a) }));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/active-tasks", () => {
  it("returns active tasks joined with visible agent info", async () => {
    mockListActive.mockResolvedValue([
      { id: "t1", agentId: "a1", prompt: "do x", status: "running", type: "dm", conversationId: "c1", channel: null, createdAt: "2026-05-30" },
    ]);
    mockGetAllAgents.mockResolvedValue([{ id: "a1", name: "Agent 1", avatarUrl: "u" }]);

    const res = await GET(new NextRequest("http://localhost/x"), {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tasks[0]).toMatchObject({
      id: "t1", agent_id: "a1", agent: { name: "Agent 1", avatarUrl: "u" }, channel: "default",
    });
    expect(mockListActive).toHaveBeenCalledWith({}, "w1");
  });

  it("yields null agent when the task's agent isn't visible", async () => {
    mockListActive.mockResolvedValue([
      { id: "t1", agentId: "hidden", prompt: "x", status: "running", type: "dm", conversationId: "c1", channel: "ops", createdAt: "d" },
    ]);
    mockGetAllAgents.mockResolvedValue([]);
    const res = await GET(new NextRequest("http://localhost/x"), {});
    const body = await res.json();
    expect(body.tasks[0].agent).toBeNull();
    expect(body.tasks[0].channel).toBe("ops");
  });
});
