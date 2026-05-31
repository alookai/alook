import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetAllAgents = vi.fn();
const mockListPins = vi.fn();
const mockReorder = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAllAgentsForWorkspace: (...a: unknown[]) => mockGetAllAgents(...a) },
      agentPin: { listPins: (...a: unknown[]) => mockListPins(...a) },
      agentSidebarOrder: { reorder: (...a: unknown[]) => mockReorder(...a) },
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
  invalidate: vi.fn().mockResolvedValue(undefined),
  cacheKeys: { allAgents: (w: string) => `ag:${w}`, pins: (w: string, u: string) => `pins:${w}:${u}` },
}));

import { PUT } from "./route";

beforeEach(() => vi.clearAllMocks());

const put = (body: unknown) =>
  PUT(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }), {});

describe("PUT /api/agents/sidebar/reorder", () => {
  it("reorders sidebar for unpinned workspace agents (204)", async () => {
    mockGetAllAgents.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    mockListPins.mockResolvedValue([]);
    const res = await put({ ordered_agent_ids: ["a2", "a1"] });
    expect(res.status).toBe(204);
    expect(mockReorder).toHaveBeenCalledWith({}, "w1", "u1", ["a2", "a1"]);
  });

  it("400 when an id is not a workspace agent", async () => {
    mockGetAllAgents.mockResolvedValue([{ id: "a1" }]);
    mockListPins.mockResolvedValue([]);
    const res = await put({ ordered_agent_ids: ["a1", "ghost"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not found");
  });

  it("400 when an id is pinned (pinned agents are excluded from sidebar order)", async () => {
    mockGetAllAgents.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    mockListPins.mockResolvedValue([{ agentId: "a1" }]);
    const res = await put({ ordered_agent_ids: ["a1", "a2"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("is pinned");
  });

  it("400 on empty array", async () => {
    const res = await put({ ordered_agent_ids: [] });
    expect(res.status).toBe(400);
  });
});
