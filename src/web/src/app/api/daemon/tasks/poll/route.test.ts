import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetRuntimeIdsByDaemon = vi.fn();
const mockUpdateRuntimesLastSeen = vi.fn();
const mockGetAgent = vi.fn();
const mockClaimTasksForRuntimes = vi.fn();
const mockSweepStaleState = vi.fn();
const mockBroadcastToUser = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    createDb: vi.fn(() => ({})),
    queries: {
      runtime: {
        getRuntimeIdsByDaemon: (...args: unknown[]) => mockGetRuntimeIdsByDaemon(...args),
        updateRuntimesLastSeen: (...args: unknown[]) => mockUpdateRuntimesLastSeen(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/services/task", () => ({
  TaskService: class {
    claimTasksForRuntimes(...args: unknown[]) { return mockClaimTasksForRuntimes(...args); }
  },
}));

vi.mock("@/lib/services/sweep", () => ({
  sweepStaleState: (...args: unknown[]) => mockSweepStaleState(...args),
}));

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...args: unknown[]) => mockBroadcastToUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (t: any) => ({
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    workspace_id: t.workspaceId,
    prompt: t.prompt,
    status: t.status,
  }),
}));

import { POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/tasks/poll", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/tasks/poll", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty tasks array when daemon has no runtimes", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue([]);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(mockUpdateRuntimesLastSeen).not.toHaveBeenCalled();
    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });

  it("resolves runtime IDs from daemon_id and updates last_seen_at", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1", "r2"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockGetRuntimeIdsByDaemon).toHaveBeenCalledWith({}, "d1", "w1");
    expect(mockUpdateRuntimesLastSeen).toHaveBeenCalledWith({}, ["r1", "r2"], "w1");
  });

  it("returns tasks with agent data for claimed tasks", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1", "r2"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "do it", status: "dispatched" },
    ]);
    mockGetAgent.mockResolvedValue({
      instructions: "be helpful",
      name: "Bot",
      runtimeConfig: { model: "gpt-4" },
    });

    const res = await POST(postReq({ daemon_id: "d1", max_tasks: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("t1");
    expect(body.tasks[0].agent).toEqual({
      instructions: "be helpful",
      name: "Bot",
      runtime_config: { model: "gpt-4" },
    });
  });

  it("broadcasts single runtime.status with daemonId and workspaceId", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2", "r3"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1", "r2", "r3"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    // Single broadcast, not per-runtime
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "runtime.status",
      daemonId: "d1",
      workspaceId: "w1",
      status: "online",
    });
  });

  it("calls sweepStaleState", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockSweepStaleState).toHaveBeenCalledWith({}, "w1");
  });

  it("respects max_tasks parameter", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1", max_tasks: 5 }));

    expect(mockClaimTasksForRuntimes).toHaveBeenCalledWith(["r1"], 5, "w1");
  });

  it("defaults max_tasks to 1", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockClaimTasksForRuntimes).toHaveBeenCalledWith(["r1"], 1, "w1");
  });

  it("logs warning when some runtimes not found", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2"]);
    mockUpdateRuntimesLastSeen.mockResolvedValue(["r1"]); // only 1 of 2 found
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    const { log } = await import("@/lib/logger");
    expect(log.warn).toHaveBeenCalledWith("Some runtime IDs not found in workspace", {
      expected: 2,
      updated: 1,
    });
  });
});
