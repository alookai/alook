import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockListActiveTasksByAgent = vi.fn();

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
    agent: { getAgent: (...args: any[]) => mockGetAgent(...args) },
    task: { listActiveTasksByAgent: (...args: any[]) => mockListActiveTasksByAgent(...args) },
  },
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

import { GET } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/agents/[id]/active-tasks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct task list", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListActiveTasksByAgent.mockResolvedValue([
      { id: "t1", status: "running", type: "user_dm_message", conversationId: "c1", createdAt: "2026-01-01T00:00:00Z" },
      { id: "t2", status: "queued", type: "email_notification", conversationId: "c2", createdAt: "2026-01-01T00:01:00Z" },
      { id: "t3", status: "running", type: "issue_event", conversationId: "c3", createdAt: "2026-01-01T00:02:00Z" },
    ]);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/a1/active-tasks"),
      withParams("a1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toHaveLength(3);
    expect(body.tasks[0]).toEqual({
      id: "t1",
      status: "running",
      type: "user_dm_message",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(body.tasks[1]).toEqual({
      id: "t2",
      status: "queued",
      type: "email_notification",
      created_at: "2026-01-01T00:01:00Z",
    });
    expect(body.tasks[2]).toEqual({
      id: "t3",
      status: "running",
      type: "issue_event",
      created_at: "2026-01-01T00:02:00Z",
    });
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/a1/active-tasks"),
      withParams("a1")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns empty tasks array when no active tasks", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListActiveTasksByAgent.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/agents/a1/active-tasks"),
      withParams("a1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
  });

  it("passes userId to query for data isolation", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListActiveTasksByAgent.mockResolvedValue([]);

    await GET(
      new NextRequest("http://localhost/api/agents/a1/active-tasks"),
      withParams("a1")
    );

    expect(mockListActiveTasksByAgent).toHaveBeenCalledWith({}, "a1", "w1", "u1");
  });
});
