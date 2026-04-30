import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  TASK_TYPES: {
    USER_DM_MESSAGE: "user_dm_message",
    EMAIL_NOTIFICATION: "email_notification",
    CALENDAR_EVENT: "calendar_event",
    KILL_TASK: "kill_task",
  },
  queries: {
    task: {
      createTask: vi.fn(),
      claimTask: vi.fn(),
      startTask: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn(),
      supersedeTask: vi.fn(),
      markFailedAsSuperseded: vi.fn(),
      getTask: vi.fn(),
      countRunningTasks: vi.fn(),
      listPendingTasksByRuntimes: vi.fn(),
      claimKillTasks: vi.fn().mockResolvedValue([]),
      getActiveTaskByConversation: vi.fn(),
      cancelTask: vi.fn(),
      findSteerableReplacement: vi.fn().mockResolvedValue(null),
    },
    agent: {
      getAgent: vi.fn(),
      updateAgentStatus: vi.fn(),
    },
    message: {
      createMessage: vi.fn(),
      activateNextBufferedMessage: vi.fn(),
      revertToBuffered: vi.fn().mockResolvedValue(null),
    },
    conversation: {
      getConversation: vi.fn(),
    },
  },
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

import { TaskService } from "./task";
import { queries } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";

const taskQ = queries.task as {
  [K in keyof typeof queries.task]: ReturnType<typeof vi.fn>;
};
const agentQ = queries.agent as {
  [K in keyof typeof queries.agent]: ReturnType<typeof vi.fn>;
};
const messageQ = queries.message as {
  [K in keyof typeof queries.message]: ReturnType<typeof vi.fn>;
};
const conversationQ = (queries as any).conversation as {
  getConversation: ReturnType<typeof vi.fn>;
};

const service = new TaskService({} as any);

describe("TaskService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no buffered messages to dispatch
    messageQ.activateNextBufferedMessage.mockResolvedValue(null);
    // Default: no kill tasks to claim
    taskQ.claimKillTasks.mockResolvedValue([]);
  });

  // ── enqueueTask ──────────────────────────────────────────────────

  describe("enqueueTask", () => {
    it("throws when agent not found", async () => {
      agentQ.getAgent.mockResolvedValue(null);

      await expect(
        service.enqueueTask("a1", "c1", "w1", "do stuff")
      ).rejects.toThrow("agent not found");
    });

    it("throws when agent has no runtime", async () => {
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: null });

      await expect(
        service.enqueueTask("a1", "c1", "w1", "do stuff")
      ).rejects.toThrow("agent has no runtime");
    });

    it("creates task with correct params on success", async () => {
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({ id: "t1" });

      const result = await service.enqueueTask("a1", "c1", "w1", "do stuff");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, {
        agentId: "a1",
        runtimeId: "r1",
        workspaceId: "w1",
        conversationId: "c1",
        prompt: "do stuff",
        type: "user_dm_message",
        contextKey: null,
        priority: 0,
      });
      expect(result).toEqual({ id: "t1" });
    });
  });

  // ── claimTask ────────────────────────────────────────────────────

  describe("claimTask", () => {
    it("returns null when agent not found", async () => {
      agentQ.getAgent.mockResolvedValue(null);

      const result = await service.claimTask("a1", "w1");
      expect(result).toBeNull();
    });

    it("returns null when at max capacity", async () => {
      agentQ.getAgent.mockResolvedValue({
        id: "a1",
        maxConcurrentTasks: 2,
      });
      taskQ.countRunningTasks.mockResolvedValue(2);

      const result = await service.claimTask("a1", "w1");
      expect(result).toBeNull();
    });

    it("returns null when no queued tasks", async () => {
      agentQ.getAgent.mockResolvedValue({
        id: "a1",
        maxConcurrentTasks: 5,
      });
      taskQ.countRunningTasks.mockResolvedValue(0);
      taskQ.claimTask.mockResolvedValue(null);

      const result = await service.claimTask("a1", "w1");
      expect(result).toBeNull();
    });

    it("claims task and updates agent to working on success", async () => {
      agentQ.getAgent.mockResolvedValue({
        id: "a1",
        maxConcurrentTasks: 5,
      });
      taskQ.countRunningTasks.mockResolvedValue(1);
      taskQ.claimTask.mockResolvedValue({ id: "t1", agentId: "a1" });

      const result = await service.claimTask("a1", "w1");

      expect(result).toEqual({ id: "t1", agentId: "a1" });
      expect(agentQ.updateAgentStatus).toHaveBeenCalledWith(
        {},
        "a1",
        "w1",
        "working"
      );
    });
  });

  // ── claimTasksForRuntimes ─────────────────────────────────────────

  describe("claimTasksForRuntimes", () => {
    it("returns empty array when no pending tasks", async () => {
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([]);

      const result = await service.claimTasksForRuntimes(["r1"], 1, "w1");
      expect(result).toEqual([]);
    });

    it("deduplicates by agent ID and workspace ID", async () => {
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([
        { agentId: "a1", workspaceId: "w1", id: "t1", runtimeId: "r1" },
        { agentId: "a1", workspaceId: "w1", id: "t2", runtimeId: "r1" },
      ]);
      agentQ.getAgent.mockResolvedValue({
        id: "a1",
        maxConcurrentTasks: 5,
      });
      taskQ.countRunningTasks.mockResolvedValue(0);
      taskQ.claimTask.mockResolvedValue({
        id: "t1",
        agentId: "a1",
        runtimeId: "r1",
      });

      const result = await service.claimTasksForRuntimes(["r1"], 5, "w1");

      expect(result).toEqual([{ id: "t1", agentId: "a1", runtimeId: "r1" }]);
      expect(taskQ.claimTask).toHaveBeenCalledTimes(1);
    });

    it("respects maxTasks limit", async () => {
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([
        { agentId: "a1", workspaceId: "w1", id: "t1", runtimeId: "r1" },
        { agentId: "a2", workspaceId: "w1", id: "t2", runtimeId: "r1" },
        { agentId: "a3", workspaceId: "w1", id: "t3", runtimeId: "r1" },
      ]);
      agentQ.getAgent.mockResolvedValue({ id: "a1", maxConcurrentTasks: 5 });
      taskQ.countRunningTasks.mockResolvedValue(0);

      let callCount = 0;
      taskQ.claimTask.mockImplementation(async () => {
        callCount++;
        return { id: `t${callCount}`, agentId: `a${callCount}`, runtimeId: "r1" };
      });

      const result = await service.claimTasksForRuntimes(["r1"], 2, "w1");
      expect(result).toHaveLength(2);
    });

    it("skips claimed task whose runtimeId is not in the provided set", async () => {
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([
        { agentId: "a1", workspaceId: "w1", id: "t1", runtimeId: "r1" },
      ]);
      agentQ.getAgent.mockResolvedValue({ id: "a1", maxConcurrentTasks: 5 });
      taskQ.countRunningTasks.mockResolvedValue(0);
      taskQ.claimTask.mockResolvedValue({
        id: "t1",
        agentId: "a1",
        runtimeId: "r2", // different runtime than provided
      });

      const result = await service.claimTasksForRuntimes(["r1"], 5, "w1");
      expect(result).toEqual([]);
    });

    it("returns tasks across multiple runtimes", async () => {
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([
        { agentId: "a1", workspaceId: "w1", id: "t1", runtimeId: "r1" },
        { agentId: "a2", workspaceId: "w1", id: "t2", runtimeId: "r2" },
      ]);
      agentQ.getAgent.mockResolvedValue({ id: "a1", maxConcurrentTasks: 5 });
      taskQ.countRunningTasks.mockResolvedValue(0);

      let callCount = 0;
      taskQ.claimTask.mockImplementation(async () => {
        callCount++;
        const rid = callCount === 1 ? "r1" : "r2";
        return { id: `t${callCount}`, agentId: `a${callCount}`, runtimeId: rid };
      });

      const result = await service.claimTasksForRuntimes(["r1", "r2"], 5, "w1");
      expect(result).toHaveLength(2);
    });
  });

  // ── startTask ────────────────────────────────────────────────────

  describe("startTask", () => {
    it("throws when not in dispatched status", async () => {
      taskQ.startTask.mockResolvedValue(null);

      await expect(service.startTask("t1", "w1")).rejects.toThrow(
        "task not in dispatched status"
      );
    });

    it("returns started task on success", async () => {
      const task = { id: "t1", status: "running" };
      taskQ.startTask.mockResolvedValue(task);

      const result = await service.startTask("t1", "w1");
      expect(result).toEqual(task);
      expect(taskQ.startTask).toHaveBeenCalledWith({}, "t1", "w1");
    });
  });

  // ── completeTask ─────────────────────────────────────────────────

  describe("completeTask", () => {
    it("creates assistant message from result.output", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "completed",
      };
      taskQ.completeTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.completeTask(
        "t1",
        "w1",
        JSON.stringify({ output: "Here is the answer" }),
        "sess-1"
      );

      expect(messageQ.createMessage).toHaveBeenCalledWith({}, {
        conversationId: "c1",
        role: "assistant",
        content: "Here is the answer",
        taskId: "t1",
      });
    });

    it("does not create message when result has no output", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "completed",
      };
      taskQ.completeTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.completeTask("t1", "w1", JSON.stringify({}), "sess-1");

      expect(messageQ.createMessage).not.toHaveBeenCalled();
    });

    it("calls reconcileAgentStatus", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "completed",
      };
      taskQ.completeTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(1);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.completeTask("t1", "w1", JSON.stringify({}), "sess-1");

      expect(agentQ.updateAgentStatus).toHaveBeenCalledWith(
        {},
        "a1",
        "w1",
        "working"
      );
    });
  });

  // ── failTask ─────────────────────────────────────────────────────

  describe("failTask", () => {
    it("creates error message when error is non-empty", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "failed",
      };
      taskQ.failTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.failTask("t1", "w1", "something went wrong");

      expect(messageQ.createMessage).toHaveBeenCalledWith({}, {
        conversationId: "c1",
        role: "assistant",
        content: "Error: something went wrong",
        taskId: "t1",
      });
    });

    it("does not create message when error is empty", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "failed",
      };
      taskQ.failTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.failTask("t1", "w1", "");

      expect(messageQ.createMessage).not.toHaveBeenCalled();
    });

    it("calls reconcileAgentStatus", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "failed",
      };
      taskQ.failTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(2);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.failTask("t1", "w1", "err");

      expect(agentQ.updateAgentStatus).toHaveBeenCalledWith(
        {},
        "a1",
        "w1",
        "working"
      );
    });
  });

  // ── reconcileAgentStatus ─────────────────────────────────────────

  describe("reconcileAgentStatus", () => {
    it("sets working when running tasks > 0", async () => {
      taskQ.countRunningTasks.mockResolvedValue(3);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.reconcileAgentStatus("a1", "w1");

      expect(agentQ.updateAgentStatus).toHaveBeenCalledWith(
        {},
        "a1",
        "w1",
        "working"
      );
    });

    it("sets idle when running tasks = 0", async () => {
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.reconcileAgentStatus("a1", "w1");

      expect(agentQ.updateAgentStatus).toHaveBeenCalledWith(
        {},
        "a1",
        "w1",
        "idle"
      );
    });
  });

  // ── dispatchNextBufferedMessage ─────────────────────────────────

  describe("dispatchNextBufferedMessage", () => {
    it("returns null when no buffered messages exist", async () => {
      messageQ.activateNextBufferedMessage.mockResolvedValue(null);

      const result = await service.dispatchNextBufferedMessage("c1", "w1");

      expect(result).toBeNull();
      expect(conversationQ.getConversation).not.toHaveBeenCalled();
    });

    it("activates first buffered message and enqueues task", async () => {
      const activated = {
        id: "msg1",
        conversationId: "c1",
        role: "user",
        content: "follow-up",
        taskId: null,
        attachmentIds: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      messageQ.activateNextBufferedMessage.mockResolvedValue(activated);
      conversationQ.getConversation.mockResolvedValue({
        id: "c1",
        agentId: "a1",
        userId: "u1",
        workspaceId: "w1",
      });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({
        id: "t1",
        agentId: "a1",
        runtimeId: "r1",
        workspaceId: "w1",
        conversationId: "c1",
        prompt: "follow-up",
        status: "queued",
        priority: 0,
        createdAt: "2026-01-01",
        dispatchedAt: null,
        startedAt: null,
        completedAt: null,
      });

      const result = await service.dispatchNextBufferedMessage("c1", "w1");

      expect(result).toBeTruthy();
      expect(result!.id).toBe("t1");
      expect(broadcastToUser).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ type: "followup.dispatched" })
      );
    });

    it("forwards attachment context when buffered message has attachments", async () => {
      const activated = {
        id: "msg2",
        conversationId: "c1",
        role: "user",
        content: "with files",
        taskId: null,
        attachmentIds: '["art_1","art_2"]',
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      messageQ.activateNextBufferedMessage.mockResolvedValue(activated);
      conversationQ.getConversation.mockResolvedValue({
        id: "c1",
        agentId: "a1",
        userId: "u1",
        workspaceId: "w1",
      });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({
        id: "t2",
        agentId: "a1",
        runtimeId: "r1",
        workspaceId: "w1",
        conversationId: "c1",
        prompt: "with files",
        status: "queued",
        priority: 0,
        createdAt: "2026-01-01",
        dispatchedAt: null,
        startedAt: null,
        completedAt: null,
      });

      await service.dispatchNextBufferedMessage("c1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          context: { attachment_ids: ["art_1", "art_2"] },
        })
      );
    });

    it("does NOT re-throw when enqueueTask fails", async () => {
      const activated = {
        id: "msg3",
        conversationId: "c1",
        role: "user",
        content: "will fail",
        taskId: null,
        attachmentIds: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      messageQ.activateNextBufferedMessage.mockResolvedValue(activated);
      conversationQ.getConversation.mockResolvedValue({
        id: "c1",
        agentId: "a1",
        userId: "u1",
        workspaceId: "w1",
      });
      agentQ.getAgent.mockResolvedValue(null);

      const result = await service.dispatchNextBufferedMessage("c1", "w1");

      expect(result).toBeNull();
      expect(messageQ.revertToBuffered).toHaveBeenCalledWith({}, "msg3");
      expect(broadcastToUser).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ type: "followup.dispatch_failed" })
      );
    });

    it("returns null when conversation not found", async () => {
      const activated = {
        id: "msg4",
        conversationId: "c1",
        role: "user",
        content: "test",
        taskId: null,
        attachmentIds: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      messageQ.activateNextBufferedMessage.mockResolvedValue(activated);
      conversationQ.getConversation.mockResolvedValue(null);

      const result = await service.dispatchNextBufferedMessage("c1", "w1");

      expect(result).toBeNull();
      expect(messageQ.revertToBuffered).toHaveBeenCalledWith({}, "msg4");
    });
  });

  // ── completeTask dispatches buffered ─────────────────────────────

  describe("completeTask dispatches buffered messages", () => {
    it("calls dispatchNextBufferedMessage after completion", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "completed",
      };
      taskQ.completeTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.completeTask("t1", "w1", JSON.stringify({}), "sess-1");

      expect(messageQ.activateNextBufferedMessage).toHaveBeenCalledWith({}, "c1");
    });
  });

  // ── failTask dispatches buffered ────────────────────────────────

  describe("failTask dispatches buffered messages", () => {
    it("calls dispatchNextBufferedMessage after failure", async () => {
      const task = {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "failed",
      };
      taskQ.failTask.mockResolvedValue(task);
      taskQ.countRunningTasks.mockResolvedValue(0);
      agentQ.updateAgentStatus.mockResolvedValue(undefined);

      await service.failTask("t1", "w1", "err");

      expect(messageQ.activateNextBufferedMessage).toHaveBeenCalledWith({}, "c1");
    });
  });

  // ── failTask skips side-effects for kill_task ──────────────────

  describe("failTask kill_task guard", () => {
    it("skips message creation and reconciliation for kill_task type", async () => {
      const task = {
        id: "kt1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        status: "failed",
        type: "kill_task",
      };
      taskQ.failTask.mockResolvedValue(task);

      const result = await service.failTask("kt1", "w1", "killed");

      expect(result).toEqual(task);
      expect(messageQ.createMessage).not.toHaveBeenCalled();
      expect(taskQ.countRunningTasks).not.toHaveBeenCalled();
      expect(agentQ.updateAgentStatus).not.toHaveBeenCalled();
      expect(messageQ.activateNextBufferedMessage).not.toHaveBeenCalled();
    });
  });

  // ── cancelActiveTask ─────────────────────────────────────────

  describe("cancelActiveTask", () => {
    it("returns null when no active task", async () => {
      taskQ.getActiveTaskByConversation.mockResolvedValue(null);

      const result = await service.cancelActiveTask("c1", "w1");
      expect(result).toBeNull();
    });

    it("cancels queued task without creating kill_task", async () => {
      const task = { id: "t1", status: "queued", agentId: "a1", runtimeId: "r1", conversationId: "c1" };
      taskQ.getActiveTaskByConversation.mockResolvedValue(task);
      taskQ.cancelTask.mockResolvedValue({ ...task, status: "cancelled" });
      taskQ.countRunningTasks.mockResolvedValue(0);

      const result = await service.cancelActiveTask("c1", "w1");

      expect(result!.status).toBe("cancelled");
      expect(taskQ.createTask).not.toHaveBeenCalled();
      expect(messageQ.createMessage).toHaveBeenCalledWith({}, expect.objectContaining({
        content: "Task cancelled by user",
        taskId: "t1",
      }));
    });

    it("creates kill_task for running task", async () => {
      const task = { id: "t1", status: "running", agentId: "a1", runtimeId: "r1", conversationId: "c1" };
      taskQ.getActiveTaskByConversation.mockResolvedValue(task);
      taskQ.cancelTask.mockResolvedValue({ ...task, status: "cancelled" });
      taskQ.countRunningTasks.mockResolvedValue(0);

      await service.cancelActiveTask("c1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        type: "kill_task",
        agentId: "a1",
        runtimeId: "r1",
        conversationId: "c1",
        context: { target_task_id: "t1" },
      }));
    });

    it("creates kill_task for dispatched task", async () => {
      const task = { id: "t1", status: "dispatched", agentId: "a1", runtimeId: "r1", conversationId: "c1" };
      taskQ.getActiveTaskByConversation.mockResolvedValue(task);
      taskQ.cancelTask.mockResolvedValue({ ...task, status: "cancelled" });
      taskQ.countRunningTasks.mockResolvedValue(0);

      await service.cancelActiveTask("c1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        type: "kill_task",
        context: { target_task_id: "t1" },
      }));
    });

    it("dispatches next buffered message after cancel", async () => {
      const task = { id: "t1", status: "running", agentId: "a1", runtimeId: "r1", conversationId: "c1" };
      taskQ.getActiveTaskByConversation.mockResolvedValue(task);
      taskQ.cancelTask.mockResolvedValue({ ...task, status: "cancelled" });
      taskQ.countRunningTasks.mockResolvedValue(0);

      await service.cancelActiveTask("c1", "w1");

      expect(messageQ.activateNextBufferedMessage).toHaveBeenCalledWith({}, "c1");
    });
  });

  // ── retryTask ──────────────────────────────────────────────

  describe("retryTask", () => {
    const failedTask = {
      id: "t1",
      agentId: "a1",
      workspaceId: "w1",
      conversationId: "c1",
      prompt: "do stuff",
      type: "user_dm_message",
      status: "failed",
      context: null,
    };

    it("throws when task not found", async () => {
      taskQ.getTask.mockResolvedValue(null);

      await expect(service.retryTask("t1", "w1")).rejects.toThrow("task not found");
    });

    it("throws when workspace mismatch", async () => {
      taskQ.getTask.mockResolvedValue({ ...failedTask, workspaceId: "other" });

      await expect(service.retryTask("t1", "w1")).rejects.toThrow("task not found");
    });

    it("throws when task is not failed", async () => {
      taskQ.getTask.mockResolvedValue({ ...failedTask, status: "completed" });

      await expect(service.retryTask("t1", "w1")).rejects.toThrow("only failed tasks can be retried");
    });

    it("marks old task as superseded and creates new task", async () => {
      taskQ.getTask.mockResolvedValue(failedTask);
      taskQ.markFailedAsSuperseded.mockResolvedValue({ ...failedTask, status: "superseded" });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({ id: "t2", status: "queued" });

      const { oldTask, newTask } = await service.retryTask("t1", "w1");

      expect(taskQ.markFailedAsSuperseded).toHaveBeenCalledWith({}, "t1", "w1");
      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        agentId: "a1",
        conversationId: "c1",
        workspaceId: "w1",
        prompt: "do stuff",
        type: "user_dm_message",
      }));
      expect(oldTask.status).toBe("superseded");
      expect(newTask.status).toBe("queued");
    });

    it("throws when markFailedAsSuperseded fails", async () => {
      taskQ.getTask.mockResolvedValue(failedTask);
      taskQ.markFailedAsSuperseded.mockResolvedValue(null);

      await expect(service.retryTask("t1", "w1")).rejects.toThrow("failed to mark task as superseded");
    });

    it("preserves context from original task", async () => {
      const taskWithContext = { ...failedTask, context: { attachment_ids: ["a1"] } };
      taskQ.getTask.mockResolvedValue(taskWithContext);
      taskQ.markFailedAsSuperseded.mockResolvedValue({ ...taskWithContext, status: "superseded" });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({ id: "t2", status: "queued" });

      await service.retryTask("t1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        context: { attachment_ids: ["a1"] },
      }));
    });

    it("propagates contextKey from original task", async () => {
      const taskWithKey = { ...failedTask, contextKey: "c1" };
      taskQ.getTask.mockResolvedValue(taskWithKey);
      taskQ.markFailedAsSuperseded.mockResolvedValue({ ...taskWithKey, status: "superseded" });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({ id: "t2", status: "queued" });

      await service.retryTask("t1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        contextKey: "c1",
      }));
    });

    it("handles original task with contextKey: null gracefully", async () => {
      const taskNoKey = { ...failedTask, contextKey: null };
      taskQ.getTask.mockResolvedValue(taskNoKey);
      taskQ.markFailedAsSuperseded.mockResolvedValue({ ...taskNoKey, status: "superseded" });
      agentQ.getAgent.mockResolvedValue({ id: "a1", runtimeId: "r1" });
      taskQ.createTask.mockResolvedValue({ id: "t2", status: "queued" });

      await service.retryTask("t1", "w1");

      expect(taskQ.createTask).toHaveBeenCalledWith({}, expect.objectContaining({
        contextKey: null,
      }));
    });
  });

  // ── claimTasksForRuntimes with kill_tasks ───────────────────

  describe("claimTasksForRuntimes with kill_tasks", () => {
    it("claims kill_tasks before normal tasks", async () => {
      const killTask = { id: "kt1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", type: "kill_task" };
      taskQ.claimKillTasks.mockResolvedValue([killTask]);
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([]);

      const result = await service.claimTasksForRuntimes(["r1"], 2, "w1");

      expect(result).toEqual([killTask]);
      expect(taskQ.claimKillTasks).toHaveBeenCalledWith({}, ["r1"], "w1", 2);
    });

    it("subtracts kill_tasks from remaining capacity", async () => {
      const killTask = { id: "kt1", agentId: "a1", runtimeId: "r1", workspaceId: "w1", type: "kill_task" };
      taskQ.claimKillTasks.mockResolvedValue([killTask]);
      taskQ.listPendingTasksByRuntimes.mockResolvedValue([
        { agentId: "a2", workspaceId: "w1", id: "t2", runtimeId: "r1" },
      ]);
      agentQ.getAgent.mockResolvedValue({ id: "a2", maxConcurrentTasks: 5 });
      taskQ.countRunningTasks.mockResolvedValue(0);
      taskQ.claimTask.mockResolvedValue({ id: "t2", agentId: "a2", runtimeId: "r1" });

      const result = await service.claimTasksForRuntimes(["r1"], 1, "w1");

      // Only the kill_task — maxTasks=1 is fully consumed
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("kt1");
    });
  });
});
