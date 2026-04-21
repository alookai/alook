import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListActiveTaskCountsByWorkspace = vi.fn();

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
vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    task: {
      listActiveTaskCountsByWorkspace: (...args: any[]) =>
        mockListActiveTaskCountsByWorkspace(...args),
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

import { GET } from "./route";

describe("GET /api/agents/active-task-counts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct counts per agent", async () => {
    mockListActiveTaskCountsByWorkspace.mockResolvedValue([
      { agentId: "a1", count: 3 },
      { agentId: "a2", count: 1 },
    ]);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/active-task-counts"),
      {}
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ counts: { a1: 3, a2: 1 } });
    expect(mockListActiveTaskCountsByWorkspace).toHaveBeenCalledWith({}, "w1");
  });

  it("returns empty counts when no active tasks", async () => {
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
