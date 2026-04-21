import type { Database } from "@alook/shared";
import { queries, TASK_TYPES, buildContextKey } from "@alook/shared";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";
import { messageToResponse, taskToResponse } from "@/lib/api/responses";

const taskQueries = queries.task;
const agentQueries = queries.agent;
const messageQueries = queries.message;
const conversationQueries = queries.conversation;

export class TaskService {
  constructor(private db: Database) {}

  async enqueueTask(
    agentId: string,
    conversationId: string,
    workspaceId: string,
    prompt: string,
    type: string = TASK_TYPES.USER_DM_MESSAGE,
    opts?: { contextKey?: string | null; context?: Record<string, unknown> },
  ) {
    const agent = await agentQueries.getAgent(this.db, agentId, workspaceId);
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
      type,
      contextKey: opts?.contextKey ?? null,
      priority: 0,
      context: opts?.context,
    });
  }

  async claimTask(agentId: string, workspaceId: string) {
    const agent = await agentQueries.getAgent(this.db, agentId, workspaceId);
    if (!agent) {
      return null;
    }

    const running = await taskQueries.countRunningTasks(this.db, agentId, workspaceId);
    if (running >= agent.maxConcurrentTasks) {
      return null;
    }

    const task = await taskQueries.claimTask(this.db, agentId, workspaceId);
    if (!task) {
      return null;
    }

    await agentQueries.updateAgentStatus(this.db, agentId, workspaceId, "working");
    return task;
  }

  async claimTasksForRuntimes(runtimeIds: string[], maxTasks: number, workspaceId: string) {
    const tasks = await taskQueries.listPendingTasksByRuntimes(
      this.db,
      runtimeIds,
      workspaceId
    );
    const runtimeIdSet = new Set(runtimeIds);
    const triedAgents = new Set<string>();
    const claimed: NonNullable<Awaited<ReturnType<typeof this.claimTask>>>[] = [];

    for (const candidate of tasks) {
      if (claimed.length >= maxTasks) break;

      const key = `${candidate.agentId}:${candidate.workspaceId}`;
      if (triedAgents.has(key)) continue;
      triedAgents.add(key);

      const task = await this.claimTask(candidate.agentId, candidate.workspaceId);
      if (task && runtimeIdSet.has(task.runtimeId)) {
        claimed.push(task);
      }
    }

    return claimed;
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

    await this.reconcileAgentStatus(task.agentId, task.workspaceId);
    await this.dispatchNextBufferedMessage(task.conversationId, task.workspaceId);
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

    await this.reconcileAgentStatus(task.agentId, task.workspaceId);
    await this.dispatchNextBufferedMessage(task.conversationId, task.workspaceId);
    return task;
  }

  async reconcileAgentStatus(agentId: string, workspaceId: string) {
    const running = await taskQueries.countRunningTasks(this.db, agentId, workspaceId);
    const status = running > 0 ? "working" : "idle";
    await agentQueries.updateAgentStatus(this.db, agentId, workspaceId, status);
  }

  async dispatchNextBufferedMessage(conversationId: string, workspaceId: string) {
    const activated = await messageQueries.activateNextBufferedMessage(this.db, conversationId);
    if (!activated) return null;

    const conversation = await conversationQueries.getConversation(this.db, conversationId, workspaceId);
    if (!conversation) {
      log.warn("dispatchNextBufferedMessage: conversation not found", { conversationId });
      await messageQueries.revertToBuffered(this.db, activated.id).catch((revertErr) => {
        log.error("dispatchNextBufferedMessage: failed to revert message status", { messageId: activated.id, revertErr });
      });
      return null;
    }

    const userId = conversation.userId;

    try {
      const contextKey = buildContextKey(TASK_TYPES.USER_DM_MESSAGE, { conversationId });
      const attachmentIds = activated.attachmentIds ? JSON.parse(activated.attachmentIds) as string[] : [];
      const task = await this.enqueueTask(
        conversation.agentId,
        conversationId,
        workspaceId,
        activated.content,
        TASK_TYPES.USER_DM_MESSAGE,
        {
          contextKey,
          context: attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : undefined,
        },
      );

      broadcastToUser(userId, {
        type: "followup.dispatched",
        conversationId,
        message: messageToResponse(activated),
        task: taskToResponse(task),
      }).catch(() => {});

      return task;
    } catch (err) {
      log.warn("dispatchNextBufferedMessage: enqueueTask failed", { conversationId, err });
      await messageQueries.revertToBuffered(this.db, activated.id).catch((revertErr) => {
        log.error("dispatchNextBufferedMessage: failed to revert message status", { messageId: activated.id, revertErr });
      });
      broadcastToUser(userId, {
        type: "followup.dispatch_failed",
        conversationId,
        messageId: activated.id,
        error: err instanceof Error ? err.message : "Failed to dispatch follow-up",
      }).catch(() => {});
      return null;
    }
  }
}
