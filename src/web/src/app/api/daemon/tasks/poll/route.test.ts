import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetRuntimeIdsByDaemon = vi.fn();
const mockUpsertMachine = vi.fn();
const mockGetMachineByDaemon = vi.fn();
const mockClearPendingUpdateVersion = vi.fn();
const mockGetAgent = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();
const mockGetConversation = vi.fn();
const mockGetUser = vi.fn();
const mockClaimTasksForRuntimes = vi.fn();
const mockSweepStaleState = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockGetPendingFileRequests = vi.fn();
const mockMarkFileRequestsDispatched = vi.fn();
const mockExpireStaleFileRequests = vi.fn();
const mockListScheduledMeetings = vi.fn();
const mockClaimMeetingSession = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    createDb: vi.fn(() => ({})),
    queries: {
      runtime: {
        getRuntimeIdsByDaemon: (...args: unknown[]) => mockGetRuntimeIdsByDaemon(...args),
      },
      machine: {
        upsertMachine: (...args: unknown[]) => mockUpsertMachine(...args),
        getMachineByDaemon: (...args: unknown[]) => mockGetMachineByDaemon(...args),
        clearPendingUpdateVersion: (...args: unknown[]) => mockClearPendingUpdateVersion(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      member: {
        getMemberByUserAndWorkspace: (...args: unknown[]) => mockGetMemberByUserAndWorkspace(...args),
      },
      conversation: {
        getConversation: (...args: unknown[]) => mockGetConversation(...args),
      },
      user: {
        getUser: (...args: unknown[]) => mockGetUser(...args),
      },
      emailAccount: {
        getEmailAccountsByAgent: vi.fn().mockResolvedValue([]),
      },
      workspaceFileRequest: {
        getPendingByWorkspace: (...args: unknown[]) => mockGetPendingFileRequests(...args),
        markDispatched: (...args: unknown[]) => mockMarkFileRequestsDispatched(...args),
        expireStale: (...args: unknown[]) => mockExpireStaleFileRequests(...args),
      },
      meetingSession: {
        listScheduledMeetings: (...args: unknown[]) => mockListScheduledMeetings(...args),
        claimMeetingSession: (...args: unknown[]) => mockClaimMeetingSession(...args),
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

const mockPromoteDue = vi.fn(async () => 0);
vi.mock("@/lib/services/calendar", () => ({
  promoteDueCalendarEventsForWorkspace: (...args: unknown[]) => mockPromoteDue(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMachineByDaemon.mockResolvedValue(null);
    mockGetPendingFileRequests.mockResolvedValue([]);
    mockExpireStaleFileRequests.mockResolvedValue(undefined);
    mockListScheduledMeetings.mockResolvedValue([]);
  });

  it("returns evicted: true and skips heartbeat when daemon has no runtimes", async () => {
    mockGetRuntimeIdsByDaemon.mockResolvedValue([]);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(body.evicted).toBe(true);
    expect(mockUpsertMachine).not.toHaveBeenCalled();
    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });

  it("omits evicted field for normal polls with active runtimes", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.evicted).toBeUndefined();
    expect(mockUpsertMachine).toHaveBeenCalled();
    expect(mockBroadcastToUser).toHaveBeenCalled();
  });

  it("resolves runtime IDs from daemon_id and upserts machine liveness", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockGetRuntimeIdsByDaemon).toHaveBeenCalledWith({}, "d1", "w1");
    expect(mockUpsertMachine).toHaveBeenCalledTimes(1);
    expect(mockUpsertMachine).toHaveBeenCalledWith({}, {
      daemonId: "d1",
      workspaceId: "w1",
      deviceInfo: "d1",
    });
  });

  it("returns tasks with agent data for claimed tasks", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2"]);
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
      email_handle: null,
      email_addresses: [],
      user_email: "u@t.com",
    });
  });

  it("broadcasts single runtime.status with daemonId and workspaceId", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1", "r2", "r3"]);
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
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockSweepStaleState).toHaveBeenCalledWith({}, "w1");
  });

  it("respects max_tasks parameter", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1", max_tasks: 5 }));

    expect(mockClaimTasksForRuntimes).toHaveBeenCalledWith(["r1"], 5, "w1");
  });

  it("defaults max_tasks to 1", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockClaimTasksForRuntimes).toHaveBeenCalledWith(["r1"], 1, "w1");
  });

  it("invokes calendar promotion between sweep and task claim", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockPromoteDue.mockResolvedValue(2);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockPromoteDue).toHaveBeenCalledWith({}, "w1");
    // Calendar promotion is scoped per-call to the authenticated workspace.
    const promoteOrder = mockPromoteDue.mock.invocationCallOrder[0]!;
    const sweepOrder = mockSweepStaleState.mock.invocationCallOrder[0]!;
    const claimOrder = mockClaimTasksForRuntimes.mock.invocationCallOrder[0]!;
    expect(sweepOrder).toBeLessThan(promoteOrder);
    expect(promoteOrder).toBeLessThan(claimOrder);
  });

  it("does not fail the poll when calendar promotion throws", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockPromoteDue.mockRejectedValue(new Error("D1 write failed"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    expect(res.status).toBe(200);
    expect(mockClaimTasksForRuntimes).toHaveBeenCalled();
  });

  it("returns pending_update when pendingUpdateVersion is set and cli_version is older", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetMachineByDaemon.mockResolvedValue({ pendingUpdateVersion: "1.0.0" });

    const res = await POST(postReq({ daemon_id: "d1", cli_version: "0.5.0" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_update).toEqual({ version: "1.0.0" });
  });

  it("does not return pending_update when pendingUpdateVersion is not set", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetMachineByDaemon.mockResolvedValue({ pendingUpdateVersion: null });

    const res = await POST(postReq({ daemon_id: "d1", cli_version: "0.5.0" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_update).toBeUndefined();
  });

  it("auto-clears pendingUpdateVersion when cli_version >= pending version", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetMachineByDaemon.mockResolvedValue({ pendingUpdateVersion: "1.0.0" });
    mockClearPendingUpdateVersion.mockResolvedValue(undefined);

    const res = await POST(postReq({ daemon_id: "d1", cli_version: "1.0.0" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_update).toBeUndefined();
    expect(mockClearPendingUpdateVersion).toHaveBeenCalledWith({}, "d1");
  });

  it("does not attach pending_update when cli_version is missing (backward compat)", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetMachineByDaemon.mockResolvedValue({ pendingUpdateVersion: "1.0.0" });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_update).toBeUndefined();
    expect(mockClearPendingUpdateVersion).not.toHaveBeenCalled();
  });

  it("poll without pending_update works unchanged", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetMachineByDaemon.mockResolvedValue(null);

    const res = await POST(postReq({ daemon_id: "d1", cli_version: "0.5.0" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(body.pending_update).toBeUndefined();
  });

  it("concatenates global + per-agent instructions when owner has global instruction", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "hi", status: "dispatched" },
    ]);
    mockGetAgent.mockResolvedValue({
      id: "a1",
      ownerId: "owner1",
      instructions: "you are a planner",
      name: "Bot",
      runtimeConfig: {},
    });
    mockGetMemberByUserAndWorkspace.mockResolvedValue({
      globalInstruction: "speak chinese",
    });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks[0].agent.instructions).toBe("speak chinese\n\nyou are a planner");
    expect(mockGetMemberByUserAndWorkspace).toHaveBeenCalledWith({}, "owner1", "w1");
  });

  it("returns only agent instructions when global instruction is empty", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "hi", status: "dispatched" },
    ]);
    mockGetAgent.mockResolvedValue({
      id: "a1",
      ownerId: "owner1",
      instructions: "you are a planner",
      name: "Bot",
      runtimeConfig: {},
    });
    mockGetMemberByUserAndWorkspace.mockResolvedValue({
      globalInstruction: "",
    });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].agent.instructions).toBe("you are a planner");
  });

  it("falls back to agent instructions when agent has no ownerId", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "hi", status: "dispatched" },
    ]);
    mockGetAgent.mockResolvedValue({
      id: "a1",
      ownerId: null,
      instructions: "just agent",
      name: "Bot",
      runtimeConfig: {},
    });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].agent.instructions).toBe("just agent");
    expect(mockGetMemberByUserAndWorkspace).not.toHaveBeenCalled();
  });

  it("caches member lookups by ownerId across multiple tasks", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "hi", status: "dispatched" },
      { id: "t2", agentId: "a2", runtimeId: "r1", workspaceId: "w1", prompt: "yo", status: "dispatched" },
    ]);
    mockGetAgent
      .mockResolvedValueOnce({ id: "a1", ownerId: "owner1", instructions: "inst1", name: "Bot1", runtimeConfig: {} })
      .mockResolvedValueOnce({ id: "a2", ownerId: "owner1", instructions: "inst2", name: "Bot2", runtimeConfig: {} });
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ globalInstruction: "global" });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].agent.instructions).toBe("global\n\ninst1");
    expect(body.tasks[1].agent.instructions).toBe("global\n\ninst2");
    expect(mockGetMemberByUserAndWorkspace).toHaveBeenCalledTimes(1);
  });

  it("returns only global instruction when agent instructions are empty", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", prompt: "hi", status: "dispatched" },
    ]);
    mockGetAgent.mockResolvedValue({
      id: "a1",
      ownerId: "owner1",
      instructions: "",
      name: "Bot",
      runtimeConfig: {},
    });
    mockGetMemberByUserAndWorkspace.mockResolvedValue({
      globalInstruction: "global only",
    });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].agent.instructions).toBe("global only");
  });

  it("resolves sender for DM tasks (owner)", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "hi", status: "dispatched", type: "user_dm_message" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1", instructions: "", name: "Bot", runtimeConfig: {} });
    mockGetConversation.mockResolvedValue({ userId: "u1" });
    mockGetUser.mockResolvedValue({ name: "Gus", email: "gus@ex.com" });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toEqual({ name: "Gus", email: "gus@ex.com", is_owner: true });
  });

  it("sets is_owner=false for non-owner DM", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "hi", status: "dispatched", type: "user_dm_message" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "owner1", instructions: "", name: "Bot", runtimeConfig: {} });
    mockGetConversation.mockResolvedValue({ userId: "u2" });
    mockGetUser.mockResolvedValue({ name: "Alice", email: "alice@ex.com" });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toEqual({ name: "Alice", email: "alice@ex.com", is_owner: false });
  });

  it("returns null sender for calendar tasks", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "standup", status: "dispatched", type: "calendar_event" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1", instructions: "", name: "Bot", runtimeConfig: {} });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toBeNull();
  });

  it("returns null sender for email tasks", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "new email", status: "dispatched", type: "email_notification" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1", instructions: "", name: "Bot", runtimeConfig: {} });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toBeNull();
  });

  it("returns null sender when conversation not found", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "hi", status: "dispatched", type: "user_dm_message" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1", instructions: "", name: "Bot", runtimeConfig: {} });
    mockGetConversation.mockResolvedValue(null);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toBeNull();
  });

  it("returns null sender when user not found", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "hi", status: "dispatched", type: "user_dm_message" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1", instructions: "", name: "Bot", runtimeConfig: {} });
    mockGetConversation.mockResolvedValue({ userId: "u1" });
    mockGetUser.mockResolvedValue(null);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toBeNull();
  });

  it("caches user lookups across multiple DM tasks from the same user", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([
      { id: "t1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c1", prompt: "hi", status: "dispatched", type: "user_dm_message" },
      { id: "t2", agentId: "a1", runtimeId: "r1", workspaceId: "w1", conversationId: "c2", prompt: "yo", status: "dispatched", type: "user_dm_message" },
    ]);
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "owner1", instructions: "", name: "Bot", runtimeConfig: {} });
    mockGetConversation.mockResolvedValue({ userId: "u1" });
    mockGetUser.mockResolvedValue({ name: "Gus", email: "gus@ex.com" });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(body.tasks[0].sender).toEqual({ name: "Gus", email: "gus@ex.com", is_owner: false });
    expect(body.tasks[1].sender).toEqual({ name: "Gus", email: "gus@ex.com", is_owner: false });
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  // --- Workspace file requests ---

  it("includes pending file_requests in response and marks them dispatched", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetPendingFileRequests.mockResolvedValue([
      { id: "wfr_1", agentId: "a1", requestType: "tree", path: "." },
      { id: "wfr_2", agentId: "a1", requestType: "read", path: "memory.md" },
    ]);
    mockMarkFileRequestsDispatched.mockResolvedValue(undefined);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.file_requests).toHaveLength(2);
    expect(body.file_requests[0]).toEqual({ id: "wfr_1", agent_id: "a1", request_type: "tree", path: "." });
    expect(body.file_requests[1]).toEqual({ id: "wfr_2", agent_id: "a1", request_type: "read", path: "memory.md" });
    expect(mockMarkFileRequestsDispatched).toHaveBeenCalledWith({}, ["wfr_1", "wfr_2"]);
  });

  it("omits file_requests field when no pending requests", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetPendingFileRequests.mockResolvedValue([]);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.file_requests).toBeUndefined();
    expect(mockMarkFileRequestsDispatched).not.toHaveBeenCalled();
  });

  it("calls expireStale to clean up old file requests", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockGetPendingFileRequests.mockResolvedValue([]);

    await POST(postReq({ daemon_id: "d1" }));

    expect(mockExpireStaleFileRequests).toHaveBeenCalledWith({}, "w1");
  });

  it("gracefully handles file request errors without failing the poll", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockExpireStaleFileRequests.mockRejectedValue(new Error("DB error"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(body.file_requests).toBeUndefined();
  });

  // --- Meeting claim via poll ---

  it("includes meetings in response when scheduled meetings exist", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockListScheduledMeetings.mockResolvedValue([
      { id: "ms1", agentId: "a1", workspaceId: "w1", meetingUrl: "https://meet.google.com/abc", participants: ["alice@test.com"], status: "scheduled", agentName: "Jarvis" },
    ]);
    mockClaimMeetingSession.mockResolvedValue({
      id: "ms1", agentId: "a1", workspaceId: "w1", meetingUrl: "https://meet.google.com/abc", participants: ["alice@test.com"], status: "joining",
    });

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0]).toEqual({
      id: "ms1",
      meeting_url: "https://meet.google.com/abc",
      participants: ["alice@test.com"],
      workspace_id: "w1",
      agent_name: "Jarvis",
    });
  });

  it("omits meetings field when no scheduled meetings", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockListScheduledMeetings.mockResolvedValue([]);

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meetings).toBeUndefined();
  });

  it("gracefully handles meeting claim errors without failing the poll", async () => {
    mockUpsertMachine.mockResolvedValue({});
    mockGetRuntimeIdsByDaemon.mockResolvedValue(["r1"]);
    mockSweepStaleState.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);
    mockClaimTasksForRuntimes.mockResolvedValue([]);
    mockListScheduledMeetings.mockRejectedValue(new Error("DB error"));

    const res = await POST(postReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(body.meetings).toBeUndefined();
  });
});
