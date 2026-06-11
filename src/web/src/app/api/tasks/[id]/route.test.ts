import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTask = vi.fn();
const mockGetAgent = vi.fn();
const mockTaskToResponse = vi.fn((t: any) => ({
  id: t.id,
  agent_id: t.agentId,
  workspace_id: t.workspaceId,
  status: t.status,
  prompt: t.prompt,
}));

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
  createDb: vi.fn(() => ({})),
  queries: {
    task: {
      getTask: (...args: any[]) => mockGetTask(...args),
    },
    agent: {
      getAgent: (...args: any[]) => mockGetAgent(...args),
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
vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));

import { GET } from "./route";

describe("GET /api/tasks/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns task", async () => {
    const task = {
      id: "t1",
      agentId: "a1",
      workspaceId: "w1",
      status: "completed",
      prompt: "hello",
    };
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      id: "t1",
      agent_id: "a1",
      workspace_id: "w1",
      status: "completed",
      prompt: "hello",
    });
    expect(mockGetTask).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("returns 404 when not found (scoped by workspace)", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});
