import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFailStaleDispatchedTasks = vi.fn();
const mockCountRunningTasks = vi.fn();
const mockUpdateAgentStatus = vi.fn();
const mockActivateNextBufferedMessage = vi.fn();
const mockGetConversation = vi.fn();
const mockGetAgent = vi.fn();
const mockCreateTask = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  queries: {
    task: {
      failStaleDispatchedTasks: (...args: unknown[]) => mockFailStaleDispatchedTasks(...args),
      countRunningTasks: (...args: unknown[]) => mockCountRunningTasks(...args),
      createTask: (...args: unknown[]) => mockCreateTask(...args),
    },
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
      updateAgentStatus: (...args: unknown[]) => mockUpdateAgentStatus(...args),
    },
    message: {
      activateNextBufferedMessage: (...args: unknown[]) => mockActivateNextBufferedMessage(...args),
      createMessage: vi.fn(),
    },
    conversation: {
      getConversation: (...args: unknown[]) => mockGetConversation(...args),
    },
  },
  TASK_TYPES: { USER_DM_MESSAGE: "user_dm_message" },
  buildContextKey: () => "ctx:test",
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/responses", () => ({
  messageToResponse: (m: unknown) => m,
  taskToResponse: (t: unknown) => t,
}));

import { sweepStaleState } from "./sweep";

const db = {} as any;

describe("sweepStaleState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivateNextBufferedMessage.mockResolvedValue(null);
  });

  it("calls failStaleDispatchedTasks with workspace", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([]);

    await sweepStaleState(db, "w1");

    expect(mockFailStaleDispatchedTasks).toHaveBeenCalledWith(db, "w1");
  });

  it("reconciles agent status for each affected agent", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
      { agentId: "a2", workspaceId: "w1", conversationId: "c2" },
    ]);
    mockCountRunningTasks.mockResolvedValue(0);
    mockUpdateAgentStatus.mockResolvedValue(undefined);

    await sweepStaleState(db, "w1");

    expect(mockCountRunningTasks).toHaveBeenCalledTimes(2);
    expect(mockUpdateAgentStatus).toHaveBeenCalledTimes(2);
  });

  it("deduplicates reconcile calls by agentId:workspaceId", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
    ]);
    mockCountRunningTasks.mockResolvedValue(0);
    mockUpdateAgentStatus.mockResolvedValue(undefined);

    await sweepStaleState(db, "w1");

    expect(mockCountRunningTasks).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgentStatus).toHaveBeenCalledTimes(1);
  });

  it("handles zero stale tasks gracefully", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([]);

    await sweepStaleState(db, "w1");

    expect(mockCountRunningTasks).not.toHaveBeenCalled();
    expect(mockUpdateAgentStatus).not.toHaveBeenCalled();
  });

  it("dispatches buffered messages for affected conversations", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
      { agentId: "a2", workspaceId: "w1", conversationId: "c2" },
    ]);
    mockCountRunningTasks.mockResolvedValue(0);
    mockUpdateAgentStatus.mockResolvedValue(undefined);

    await sweepStaleState(db, "w1");

    expect(mockActivateNextBufferedMessage).toHaveBeenCalledTimes(2);
    expect(mockActivateNextBufferedMessage).toHaveBeenCalledWith(db, "c1");
    expect(mockActivateNextBufferedMessage).toHaveBeenCalledWith(db, "c2");
  });

  it("deduplicates dispatch calls by conversationId", async () => {
    mockFailStaleDispatchedTasks.mockResolvedValue([
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
      { agentId: "a1", workspaceId: "w1", conversationId: "c1" },
    ]);
    mockCountRunningTasks.mockResolvedValue(0);
    mockUpdateAgentStatus.mockResolvedValue(undefined);

    await sweepStaleState(db, "w1");

    expect(mockActivateNextBufferedMessage).toHaveBeenCalledTimes(1);
  });
});
