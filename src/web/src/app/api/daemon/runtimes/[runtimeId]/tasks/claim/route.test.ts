import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockClaimTaskForRuntime = vi.fn();
const mockGetAgent = vi.fn();
const mockGetLastTaskSession = vi.fn();
const mockTaskToResponse = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: {
      getAgent: (...args: any[]) => mockGetAgent(...args),
    },
    task: {
      getLastTaskSession: (...args: any[]) => mockGetLastTaskSession(...args),
    },
  },
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
    this.claimTaskForRuntime = (...a: any[]) => mockClaimTaskForRuntime(...a);
  } as any;
  return { TaskService: MockTaskService };
});
vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));

import { POST } from "./route";

const withParams = (runtimeId: string) => ({
  params: Promise.resolve({ runtimeId }),
});

describe("POST /api/daemon/runtimes/[runtimeId]/tasks/claim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns { task: null } when no task available", async () => {
    mockClaimTaskForRuntime.mockResolvedValue(null);

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/runtimes/rt1/tasks/claim", {
        method: "POST",
      }),
      withParams("rt1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ task: null });
    expect(mockClaimTaskForRuntime).toHaveBeenCalledWith("rt1");
  });

  it("returns task with agent data and prior session", async () => {
    const fakeTask = {
      id: "t1",
      agentId: "a1",
      conversationId: "conv1",
      runtimeId: "rt1",
      workspaceId: "w1",
      prompt: "do stuff",
      status: "dispatched",
      priority: 0,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };
    const fakeAgent = {
      id: "a1",
      name: "Agent 1",
      instructions: "be helpful",
      runtimeConfig: { model: "gpt-4" },
    };
    const fakeSession = { sessionId: "sess1" };

    mockClaimTaskForRuntime.mockResolvedValue(fakeTask);
    mockGetAgent.mockResolvedValue(fakeAgent);
    mockGetLastTaskSession.mockResolvedValue(fakeSession);
    mockTaskToResponse.mockReturnValue({
      id: "t1",
      agent_id: "a1",
      runtime_id: "rt1",
      conversation_id: "conv1",
      workspace_id: "w1",
      prompt: "do stuff",
      status: "dispatched",
      priority: 0,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
      created_at: fakeTask.createdAt,
    });

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/runtimes/rt1/tasks/claim", {
        method: "POST",
      }),
      withParams("rt1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.task).toBeTruthy();
    expect(body.task.agent).toEqual({
      instructions: "be helpful",
      name: "Agent 1",
      runtime_config: { model: "gpt-4" },
    });
    expect(body.task.prior_session_id).toBe("sess1");
    expect(mockGetAgent).toHaveBeenCalledWith({}, "a1");
    expect(mockGetLastTaskSession).toHaveBeenCalledWith({}, "a1", "conv1");
  });
});
