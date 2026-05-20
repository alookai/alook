import type { Database } from "@alook/shared";
import { queries, TASK_TYPES, MAX_TASKS_PER_TRACE } from "@alook/shared";
import { log } from "@/lib/logger";
import { broadcastToUser, broadcastToDaemon } from "@/lib/broadcast";
import { messageToResponse, taskToResponse } from "@/lib/api/responses";
import { invalidate, cacheKeys } from "@/lib/cache";
import { TaskPayloadBuilder } from "@/lib/services/task-payload-builder";

const taskQueries = queries.task;
const agentQueries = queries.agent;
const messageQueries = queries.message;
const conversationQueries = queries.conversation;
const issueQueries = queries.issue;

export class TaskService {
  constructor(private db: Database) {}

  async enqueueTask(
    agentId: string,
    conversationId: string,
    workspaceId: string,
    prompt: string,
    type: string = TASK_TYPES.USER_DM_MESSAGE,
    opts?: { contextKey?: string | null; context?: Record<string, unknown>; traceId?: string | null; parentTaskId?: string | null },
  ) {
    const agent = await agentQueries.getAgent(this.db, agentId, workspaceId);
    if (!agent) {
      throw new Error("agent not found");
    }
    if (!agent.runtimeId) {
      throw new Error("agent has no runtime");
    }

    if (opts?.traceId && opts.parentTaskId) {
      const traceCount = await taskQueries.countTasksByTrace(this.db, opts.traceId);
      if (traceCount >= MAX_TASKS_PER_TRACE) {
        throw new Error(`Trace limit reached (${MAX_TASKS_PER_TRACE} tasks). This may indicate an infinite loop between agents.`);
      }
    }

    const task = await taskQueries.createTask(this.db, {
      agentId,
      runtimeId: agent.runtimeId,
      workspaceId,
      conversationId,
      prompt,
      type,
      contextKey: opts?.contextKey ?? null,
      priority: 0,
      context: opts?.context,
      traceId: opts?.traceId ?? null,
      parentTaskId: opts?.parentTaskId ?? null,
    });
    invalidate(cacheKeys.activeTaskCounts(workspaceId)).catch(() => {});
    // Push task to daemon via WS (best-effort). Awaited to ensure task state
    // settles (dispatched on success, reverted to queued on failure) before
    // the HTTP response returns, preventing races with subsequent poll calls.
    await this.pushTaskToDaemon(task, workspaceId).catch(() => {});
    return task;
  }

  async claimTask(agentId: string, workspaceId: string) {
    const agent = await agentQueries.getAgent(this.db, agentId, workspaceId);
    if (!agent) {
      return null;
    }

    const running = await taskQueries.countRunningTasks(this.db, agentId, workspaceId);
    if (running >= agent.maxConcurrentTasks) {
      // At max capacity — check if a steerable replacement exists to bypass the limit
      const steerable = await taskQueries.findSteerableReplacement(this.db, agentId, workspaceId);
      if (!steerable) return null;
      // Re-check excluding the predecessor being replaced
      const runningExcluding = await taskQueries.countRunningTasks(this.db, agentId, workspaceId, steerable.predecessorId);
      if (runningExcluding >= agent.maxConcurrentTasks) return null;
    }

    const task = await taskQueries.claimTask(this.db, agentId, workspaceId);
    if (!task) {
      return null;
    }

    await agentQueries.updateAgentStatus(this.db, agentId, workspaceId, "working");
    return task;
  }

  async claimTasksForRuntimes(runtimeIds: string[], maxTasks: number, workspaceId: string) {
    const killTasks = await taskQueries.claimKillTasks(this.db, runtimeIds, workspaceId, maxTasks);
    const remaining = maxTasks - killTasks.length;

    const tasks = remaining > 0
      ? await taskQueries.listPendingTasksByRuntimes(this.db, runtimeIds, workspaceId)
      : [];
    const runtimeIdSet = new Set(runtimeIds);
    const triedAgents = new Set<string>();
    const claimed: NonNullable<Awaited<ReturnType<typeof this.claimTask>>>[] = [...killTasks];

    const uniqueCandidates: { agentId: string; workspaceId: string }[] = [];
    for (const candidate of tasks) {
      if (uniqueCandidates.length >= remaining) break;
      const key = `${candidate.agentId}:${candidate.workspaceId}`;
      if (triedAgents.has(key)) continue;
      triedAgents.add(key);
      uniqueCandidates.push(candidate);
    }

    const results = await Promise.all(
      uniqueCandidates.map((c) => this.claimTask(c.agentId, c.workspaceId))
    );

    for (const task of results) {
      if (task && runtimeIdSet.has(task.runtimeId)) {
        claimed.push(task);
      }
    }

    return claimed;
  }

  async startTask(taskId: string, workspaceId: string) {
    const task = await taskQueries.startTask(this.db, taskId, workspaceId);
    if (!task) {
      throw new Error("task not in dispatched status");
    }
    return task;
  }

  async completeTask(
    taskId: string,
    workspaceId: string,
    result: string,
    sessionId: string
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = { raw: result };
    }

    const task = await taskQueries.completeTask(this.db, taskId, workspaceId, {
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
      const msg = await messageQueries.createMessage(this.db, {
        conversationId: task.conversationId,
        role: "assistant",
        content: output,
        taskId,
      });

      try {
        const conversation = await conversationQueries.getConversation(this.db, task.conversationId, workspaceId);
        if (conversation) {
          broadcastToUser(conversation.userId, {
            type: "conversation.message",
            conversationId: task.conversationId,
            message: messageToResponse(msg),
          }).catch(() => {});
        }
      } catch {
        // non-critical: don't let broadcast failure block task lifecycle
      }
    }

    await this.reconcileAgentStatus(task.agentId, task.workspaceId);
    await this.dispatchNextBufferedMessage(task.conversationId, task.workspaceId);
    return task;
  }

  async failTask(taskId: string, workspaceId: string, error: string) {
    const task = await taskQueries.failTask(this.db, taskId, workspaceId, error);

    if (!task) {
      const existing = await taskQueries.getTask(this.db, taskId);
      const status = existing?.status ?? "unknown";
      log.warn(`failTask failed: task is in '${status}' status`, { taskId });
      throw new Error(`cannot fail task in '${status}' status`);
    }

    if (task.type === TASK_TYPES.KILL_TASK) {
      return task;
    }

    if (error) {
      const msg = await messageQueries.createMessage(this.db, {
        conversationId: task.conversationId,
        role: "assistant",
        content: `Error: ${error}`,
        taskId,
      });

      try {
        const conversation = await conversationQueries.getConversation(this.db, task.conversationId, workspaceId);
        if (conversation) {
          broadcastToUser(conversation.userId, {
            type: "conversation.message",
            conversationId: task.conversationId,
            message: messageToResponse(msg),
          }).catch(() => {});
        }
      } catch {
        // non-critical: don't let broadcast failure block task lifecycle
      }
    }

    await this.reconcileAgentStatus(task.agentId, task.workspaceId);
    await this.syncIssueStatusFromTask(task, "failed");
    await this.dispatchNextBufferedMessage(task.conversationId, task.workspaceId);
    return task;
  }

  private async syncIssueStatusFromTask(
    task: { id: string; type?: string | null; contextKey?: string | null; workspaceId: string; conversationId: string },
    status: "failed",
  ) {
    if (task.type !== TASK_TYPES.ISSUE_EVENT) return;

    const issue = await issueQueries.getIssueByConversation(this.db, task.conversationId, task.workspaceId);
    if (!issue || issue.status === status) return;

    const updated = await issueQueries.updateIssue(this.db, issue.id, task.workspaceId, { status });
    if (!updated) return;

    const eventMsg = await messageQueries.createMessage(this.db, {
      conversationId: task.conversationId,
      role: "event",
      content: `Issue status changed: ${issue.status} -> ${status}`,
      taskId: task.id,
      metadata: JSON.stringify({ issueId: issue.id }),
    });

    try {
      const conversation = await conversationQueries.getConversation(this.db, task.conversationId, task.workspaceId);
      if (conversation) {
        broadcastToUser(conversation.userId, {
          type: "conversation.message",
          conversationId: task.conversationId,
          message: messageToResponse(eventMsg),
        }).catch(() => {});
      }
    } catch {
      // non-critical: don't let broadcast failure block task lifecycle
    }
  }

  async supersedeTask(taskId: string, workspaceId: string) {
    const task = await taskQueries.supersedeTask(this.db, taskId, workspaceId);

    if (!task) {
      const existing = await taskQueries.getTask(this.db, taskId);
      const status = existing?.status ?? "unknown";
      log.warn(`supersedeTask failed: task is in '${status}' status`, { taskId });
      throw new Error(`cannot supersede task in '${status}' status`);
    }

    await this.reconcileAgentStatus(task.agentId, task.workspaceId);
    await this.dispatchNextBufferedMessage(task.conversationId, task.workspaceId);
    return task;
  }

  async retryTask(taskId: string, workspaceId: string) {
    const original = await taskQueries.getTask(this.db, taskId);
    if (!original) throw new Error("task not found");
    if (original.workspaceId !== workspaceId) throw new Error("task not found");
    if (original.status !== "failed") throw new Error("only failed tasks can be retried");

    const marked = await taskQueries.markFailedAsSuperseded(this.db, taskId, workspaceId);
    if (!marked) throw new Error("failed to mark task as superseded");

    const newTask = await this.enqueueTask(
      original.agentId,
      original.conversationId,
      workspaceId,
      original.prompt,
      original.type,
      {
        contextKey: original.contextKey ?? null,
        context: original.context as Record<string, unknown> | undefined,
        traceId: original.traceId ?? null,
        parentTaskId: original.parentTaskId ?? null,
      },
    );

    return { oldTask: marked, newTask };
  }

  async cancelActiveTask(conversationId: string, workspaceId: string, opts?: { skipDispatch?: boolean; reason?: string }) {
    const activeTask = await taskQueries.getActiveTaskByConversation(this.db, conversationId, workspaceId);
    if (!activeTask) return null;

    const cancelled = await taskQueries.cancelTask(this.db, activeTask.id, workspaceId);
    if (!cancelled) return null;

    if (activeTask.status === "dispatched" || activeTask.status === "running") {
      await taskQueries.createTask(this.db, {
        agentId: activeTask.agentId,
        runtimeId: activeTask.runtimeId,
        workspaceId,
        conversationId,
        prompt: "",
        type: TASK_TYPES.KILL_TASK,
        context: { target_task_id: activeTask.id },
      });
    }

    await messageQueries.createMessage(this.db, {
      conversationId,
      role: "assistant",
      content: opts?.reason ?? "Task cancelled by user",
      taskId: activeTask.id,
    });

    await this.reconcileAgentStatus(activeTask.agentId, workspaceId);
    if (!opts?.skipDispatch) {
      await this.dispatchNextBufferedMessage(conversationId, workspaceId);
    }
    return cancelled;
  }

  async reconcileAgentStatus(agentId: string, workspaceId: string) {
    const running = await taskQueries.countRunningTasks(this.db, agentId, workspaceId);
    const status = running > 0 ? "working" : "idle";
    await agentQueries.updateAgentStatus(this.db, agentId, workspaceId, status);
    invalidate(cacheKeys.activeTaskCounts(workspaceId)).catch(() => {});
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
      const contextKey = conversationId;
      const attachmentIds = activated.attachmentIds ? JSON.parse(activated.attachmentIds) as string[] : [];
      const latestTask = await taskQueries.getLatestTaskForConversation(this.db, conversationId);
      const traceId = latestTask?.traceId ?? null;
      const task = await this.enqueueTask(
        conversation.agentId,
        conversationId,
        workspaceId,
        activated.content,
        TASK_TYPES.USER_DM_MESSAGE,
        {
          contextKey,
          context: attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : undefined,
          traceId,
          parentTaskId: null,
        },
      );

      await messageQueries.updateMessageTaskId(this.db, activated.id, task.id);

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

  async cancelTrace(traceId: string, workspaceId: string, opts?: { reason?: string }) {
    const tasks = await taskQueries.getTraceTree(this.db, traceId, workspaceId);
    const activeConvIds = [...new Set(
      tasks
        .filter(t => ["queued", "dispatched", "running"].includes(t.status))
        .map(t => t.conversationId)
    )];
    for (const convId of activeConvIds) {
      try {
        await this.cancelActiveTask(convId, workspaceId, { skipDispatch: true, reason: opts?.reason });
      } catch (err) {
        log.warn("cancelTrace: failed to cancel task", { traceId, convId, err });
      }
    }
  }

  private async pushTaskToDaemon(
    task: Awaited<ReturnType<typeof taskQueries.createTask>>,
    workspaceId: string,
  ) {
    const runtime = await queries.runtime.getAgentRuntime(this.db, task.runtimeId);
    if (!runtime) return;

    const dispatched = await taskQueries.dispatchTaskById(this.db, task.id, workspaceId);
    if (!dispatched) return;

    const builder = new TaskPayloadBuilder(this.db);
    const payloads = await builder.buildFullPayloads([dispatched], workspaceId);
    if (payloads.length === 0) {
      await taskQueries.revertDispatchedToQueued(this.db, task.id, workspaceId);
      return;
    }

    try {
      await broadcastToDaemon(runtime.daemonId, {
        type: "daemon.tasks",
        tasks: payloads,
      });
    } catch {
      await taskQueries.revertDispatchedToQueued(this.db, task.id, workspaceId);
    }
  }
}
