import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockRetryTask = vi.fn();
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
vi.mock("@/lib/services/task", () => {
  const MockTaskService = function (this: any) {
    this.retryTask = (...a: any[]) => mockRetryTask(...a);
  } as any;
  return { TaskService: MockTaskService };
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
vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

describe("POST /api/tasks/[id]/retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns new task on success", async () => {
    const oldTask = { id: "t1", agentId: "a1", workspaceId: "w1", status: "superseded", prompt: "hello" };
    const newTask = { id: "t2", agentId: "a1", workspaceId: "w1", status: "queued", prompt: "hello" };
    mockRetryTask.mockResolvedValue({ oldTask, newTask });

    const res = await POST(
      new NextRequest("http://localhost/api/tasks/t1/retry", { method: "POST" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.prompt).toBe("hello");
    expect(mockRetryTask).toHaveBeenCalledWith("t1", "w1");
  });

  it("returns 400 when task is not failed", async () => {
    mockRetryTask.mockRejectedValue(new Error("only failed tasks can be retried"));

    const res = await POST(
      new NextRequest("http://localhost/api/tasks/t1/retry", { method: "POST" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("only failed tasks can be retried");
  });

  it("returns 400 when task not found", async () => {
    mockRetryTask.mockRejectedValue(new Error("task not found"));

    const res = await POST(
      new NextRequest("http://localhost/api/tasks/t1/retry", { method: "POST" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("task not found");
  });
});
