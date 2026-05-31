import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockSupersede = vi.fn();
vi.mock("@/lib/services/task", () => ({
  TaskService: function () { return { supersedeTask: mockSupersede }; },
}));
vi.mock("@/lib/api/responses", () => ({ taskToResponse: (t: any) => ({ id: t.id, status: t.status }) }));
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  invalidateInboxCounts: vi.fn().mockResolvedValue(undefined),
  cacheKeys: { overviewTaskStats: (w: string, d: string) => `ts:${w}:${d}` },
}));

let injectWorkspaceId: string | undefined = "w1";
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: injectWorkspaceId, params });
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  injectWorkspaceId = "w1";
});

const post = (params: Record<string, string>) =>
  POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });

describe("POST /api/daemon/tasks/[taskId]/supersede", () => {
  it("403 when no workspace (machine token required)", async () => {
    injectWorkspaceId = undefined;
    const res = await post({ taskId: "t1" });
    expect(res.status).toBe(403);
  });

  it("400 when taskId missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it("supersedes a task scoped to the token workspace", async () => {
    mockSupersede.mockResolvedValue({ id: "t1", agentId: "a1", status: "superseded" });
    const res = await post({ taskId: "t1" });
    expect(res.status).toBe(200);
    expect(mockSupersede).toHaveBeenCalledWith("t1", "w1");
    expect((await res.json()).id).toBe("t1");
  });

  it("400 when supersede throws (e.g. task not in workspace)", async () => {
    mockSupersede.mockRejectedValue(new Error("task not found"));
    const res = await post({ taskId: "t1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("task not found");
  });
});
