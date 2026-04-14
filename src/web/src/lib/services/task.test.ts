import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@alook/shared", () => ({
  queries: {
    task: {
      createTask: vi.fn(),
      claimTask: vi.fn(),
      startTask: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn(),
      getTask: vi.fn(),
      countRunningTasks: vi.fn(),
      listPendingTasksByRuntime: vi.fn(),
    },
    agent: {
      getAgent: vi.fn(),
      updateAgentStatus: vi.fn(),
    },
    message: {
      createMessage: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { TaskService } from "./task";
import { queries } from "@alook/shared";

const taskQ = queries.task as {
  [K in keyof typeof queries.task]: ReturnType<typeof vi.fn>;
};
const agentQ = queries.agent as {
  [K in keyof typeof queries.agent]: ReturnType<typeof vi.fn>;
};
const messageQ = queries.message as {
  [K in keyof typeof queries.message]: ReturnType<typeof vi.fn>;
};

const service = new TaskService({} as any);

describe("TaskService", () => {
  beforeEach(() => vi.clearAllMocks());

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

  // ── claimTaskForRuntime ──────────────────────────────────────────

  describe("claimTaskForRuntime", () => {
    it("returns null when no pending tasks", async () => {
      taskQ.listPendingTasksByRuntime.mockResolvedValue([]);

      const result = await service.claimTaskForRuntime("r1");
      expect(result).toBeNull();
    });

    it("deduplicates by agent ID and workspace ID", async () => {
      taskQ.listPendingTasksByRuntime.mockResolvedValue([
        { agentId: "a1", workspaceId: "w1", id: "t1" },
        { agentId: "a1", workspaceId: "w1", id: "t2" },
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

      const result = await service.claimTaskForRuntime("r1");

      expect(result).toEqual({ id: "t1", agentId: "a1", runtimeId: "r1" });
      // claimTask on the service calls agentQ internally, but the key point
      // is taskQ.claimTask should only have been called once (dedup by agentId)
      expect(taskQ.claimTask).toHaveBeenCalledTimes(1);
    });
  });

  // ── startTask ────────────────────────────────────────────────────

  describe("startTask", () => {
    it("throws when not in dispatched status", async () => {
      taskQ.startTask.mockResolvedValue(null);

      await expect(service.startTask("t1")).rejects.toThrow(
        "task not in dispatched status"
      );
    });

    it("returns started task on success", async () => {
      const task = { id: "t1", status: "running" };
      taskQ.startTask.mockResolvedValue(task);

      const result = await service.startTask("t1");
      expect(result).toEqual(task);
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

      await service.completeTask("t1", JSON.stringify({}), "sess-1");

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

      await service.completeTask("t1", JSON.stringify({}), "sess-1");

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

      await service.failTask("t1", "something went wrong");

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

      await service.failTask("t1", "");

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

      await service.failTask("t1", "err");

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
});
