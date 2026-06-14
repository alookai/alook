import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockFailTask = vi.fn();
const mockTaskToResponse = vi.fn();
const mockGetConversation = vi.fn();

let mockAuthCtx: Record<string, unknown> = { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1" };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: { withSession: () => ({}) } } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    createDb: vi.fn(() => ({})),
    queries: {
      conversation: { getConversation: (...args: any[]) => mockGetConversation(...args) },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { ...mockAuthCtx, params });
  }),
}));
vi.mock("@/lib/middleware/helpers", async () => {
  return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
    "@/lib/middleware/helpers"
  );
});
vi.mock("@/lib/services/task", () => {
  const MockTaskService = function (this: any) {
    this.failTask = (...a: any[]) => mockFailTask(...a);
  } as any;
  return { TaskService: MockTaskService };
});
vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  invalidateInboxCounts: vi.fn().mockResolvedValue(undefined),
  cacheKeys: { overviewTaskStats: (w: string, d: string) => `ts:${w}:${d}` },
}));

import { POST } from "./route";

const withParams = (taskId: string) => ({
  params: Promise.resolve({ taskId }),
});

const makeReq = (taskId: string, body: Record<string, unknown> = {}) =>
  new NextRequest(`http://localhost/api/daemon/tasks/${taskId}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/daemon/tasks/[taskId]/fail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1" };
  });

  it("returns failed task and broadcasts to conversation owner", async () => {
    const fakeTask = { id: "t1", agentId: "a1", conversationId: "c1", status: "failed" };
    mockFailTask.mockResolvedValue(fakeTask);
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "owner-u2" });
    mockTaskToResponse.mockReturnValue({ id: "t1", status: "failed" });

    const res = await POST(makeReq("t1", { error: "boom" }), withParams("t1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "t1", status: "failed" });
    expect(mockFailTask).toHaveBeenCalledWith("t1", "w1", "boom");
    const { broadcastToUser } = await import("@/lib/broadcast");
    expect(broadcastToUser).toHaveBeenCalledWith("owner-u2", expect.objectContaining({ type: "task.updated", status: "failed" }));
    const { invalidateInboxCounts } = await import("@/lib/cache");
    expect(invalidateInboxCounts).toHaveBeenCalledWith("owner-u2", "w1");
  });

  it("returns 403 when workspaceId is missing (session auth)", async () => {
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com" };

    const res = await POST(makeReq("t1", { error: "boom" }), withParams("t1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: machine token required");
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace task fail (task not found for workspace)", async () => {
    mockFailTask.mockRejectedValue(new Error("cannot fail task in 'unknown' status"));

    const res = await POST(makeReq("t-other", { error: "boom" }), withParams("t-other"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(mockFailTask).toHaveBeenCalledWith("t-other", "w1", "boom");
  });
});
