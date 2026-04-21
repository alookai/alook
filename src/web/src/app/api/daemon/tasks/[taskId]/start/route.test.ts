import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockStartTask = vi.fn();
const mockTaskToResponse = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));
vi.mock("@/lib/middleware/helpers", async () => {
  return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
    "@/lib/middleware/helpers"
  );
});
vi.mock("@/lib/services/task", () => {
  const MockTaskService = function (this: any) {
    this.startTask = (...a: any[]) => mockStartTask(...a);
  } as any;
  return { TaskService: MockTaskService };
});
vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));

import { POST } from "./route";

const withParams = (taskId: string) => ({
  params: Promise.resolve({ taskId }),
});

describe("POST /api/daemon/tasks/[taskId]/start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns started task", async () => {
    const fakeTask = {
      id: "t1",
      agentId: "a1",
      status: "running",
    };
    mockStartTask.mockResolvedValue(fakeTask);
    mockTaskToResponse.mockReturnValue({ id: "t1", status: "running" });

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/start", {
        method: "POST",
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "t1", status: "running" });
    expect(mockStartTask).toHaveBeenCalledWith("t1");
  });

  it("returns 400 when task not in dispatched status", async () => {
    mockStartTask.mockRejectedValue(new Error("task not in dispatched status"));

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/start", {
        method: "POST",
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("task not in dispatched status");
  });
});
