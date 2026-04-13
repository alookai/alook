import type { Database } from "@alook/shared";
import { queries } from "@alook/shared";
import { log } from "@/lib/logger";

const taskQueries = queries.task;
const agentQueries = queries.agent;
const messageQueries = queries.message;

export class TaskService {
  constructor(private db: Database) {}

  async enqueueTask(
    agentId: string,
    conversationId: string,
    workspaceId: string,
    prompt: string
  ) {
    const agent = await agentQueries.getAgent(this.db, agentId);
    if (!agent) {
      throw new Error("agent not found");
    }
    if (!agent.runtimeId) {
      throw new Error("agent has no runtime");
    }

    return taskQueries.createTask(this.db, {
      agentId,
      runtimeId: agent.runtimeId,
      workspaceId,
      conversationId,
      prompt,
      priority: 0,
    });
  }

  async claimTask(agentId: string) {
    const agent = await agentQueries.getAgent(this.db, agentId);
    if (!agent) {
      return null;
    }

    const running = await taskQueries.countRunningTasks(this.db, agentId);
    if (running >= agent.maxConcurrentTasks) {
      return null;
    }

    const task = await taskQueries.claimTask(this.db, agentId);
    if (!task) {
      return null;
    }

    await agentQueries.updateAgentStatus(this.db, agentId, "working");
    return task;
  }

  async claimTaskForRuntime(runtimeId: string) {
    const tasks = await taskQueries.listPendingTasksByRuntime(
      this.db,
      runtimeId
    );
    const triedAgents = new Set<string>();

    for (const candidate of tasks) {
      if (triedAgents.has(candidate.agentId)) {
        continue;
      }
      triedAgents.add(candidate.agentId);

      const task = await this.claimTask(candidate.agentId);
      if (task && task.runtimeId === runtimeId) {
        return task;
      }
    }

    return null;
  }

  async startTask(taskId: string) {
    const task = await taskQueries.startTask(this.db, taskId);
    if (!task) {
      throw new Error("task not in dispatched status");
    }
    return task;
  }

  async completeTask(
    taskId: string,
    result: string,
    sessionId: string
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = { raw: result };
    }

    const task = await taskQueries.completeTask(this.db, taskId, {
      result: parsed,
      sessionId: sessionId || null,
    });

    if (!task) {
      const existing = await taskQueries.getTask(this.db, taskId);
      const status = existing?.status ?? "unknown";
      log.warn(`completeTask failed: task is in '${status}' status`, { taskId });
      throw new Error(`cannot complete task in '${status}' status`);
    }

    const payload = parsed as Record<string, unknown>;
    const output =
      typeof payload?.output === "string" ? payload.output : "";

    if (output) {
      await messageQueries.createMessage(this.db, {
        conversationId: task.conversationId,
        role: "assistant",
        content: output,
        taskId,
      });
    }

    await this.reconcileAgentStatus(task.agentId);
    return task;
  }

  async failTask(taskId: string, error: string) {
    const task = await taskQueries.failTask(this.db, taskId, error);

    if (!task) {
      const existing = await taskQueries.getTask(this.db, taskId);
      const status = existing?.status ?? "unknown";
      log.warn(`failTask failed: task is in '${status}' status`, { taskId });
      throw new Error(`cannot fail task in '${status}' status`);
    }

    if (error) {
      await messageQueries.createMessage(this.db, {
        conversationId: task.conversationId,
        role: "assistant",
        content: `Error: ${error}`,
        taskId,
      });
    }

    await this.reconcileAgentStatus(task.agentId);
    return task;
  }

  async reconcileAgentStatus(agentId: string) {
    const running = await taskQueries.countRunningTasks(this.db, agentId);
    const status = running > 0 ? "working" : "idle";
    await agentQueries.updateAgentStatus(this.db, agentId, status);
  }
}
