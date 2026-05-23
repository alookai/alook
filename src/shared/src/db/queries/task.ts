import { eq, and, desc, asc, inArray, notInArray, ne, count, lt, or, sql, exists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { agentTaskQueue, taskMessage, conversation } from "../schema";
import type { Database } from "../index";
import { ClaimedTaskRowSchema } from "../../schemas";
import { TASK_TYPES } from "../../constants";

export async function createTask(
  db: Database,
  data: {
    agentId: string;
    runtimeId: string;
    workspaceId: string;
    conversationId: string;
    prompt: string;
    type?: string;
    contextKey?: string | null;
    priority?: number;
    context?: Record<string, unknown>;
    traceId?: string | null;
    parentTaskId?: string | null;
  }
) {
  const rows = await db
    .insert(agentTaskQueue)
    .values({
      agentId: data.agentId,
      runtimeId: data.runtimeId,
      workspaceId: data.workspaceId,
      conversationId: data.conversationId,
      prompt: data.prompt,
      type: data.type ?? TASK_TYPES.USER_DM_MESSAGE,
      contextKey: data.contextKey ?? null,
      priority: data.priority ?? 0,
      context: data.context ?? undefined,
      traceId: data.traceId ?? null,
      parentTaskId: data.parentTaskId ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function countTasksByTrace(db: Database, traceId: string) {
  const rows = await db
    .select({ value: count() })
    .from(agentTaskQueue)
    .where(eq(agentTaskQueue.traceId, traceId));
  return Number(rows[0]?.value ?? 0);
}

export async function getLatestTaskForConversation(db: Database, conversationId: string) {
  const rows = await db
    .select({
      id: agentTaskQueue.id,
      traceId: agentTaskQueue.traceId,
    })
    .from(agentTaskQueue)
    .where(eq(agentTaskQueue.conversationId, conversationId))
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getTask(db: Database, id: string, workspaceId?: string) {
  const conditions = [eq(agentTaskQueue.id, id)];
  if (workspaceId) conditions.push(eq(agentTaskQueue.workspaceId, workspaceId));
  const rows = await db
    .select()
    .from(agentTaskQueue)
    .where(and(...conditions));
  return rows[0] ?? null;
}

export async function getTaskStatus(db: Database, id: string, workspaceId?: string) {
  const conditions = [eq(agentTaskQueue.id, id)];
  if (workspaceId) conditions.push(eq(agentTaskQueue.workspaceId, workspaceId));
  const rows = await db
    .select({ status: agentTaskQueue.status })
    .from(agentTaskQueue)
    .where(and(...conditions));
  return rows[0]?.status ?? null;
}

export async function findSteerableReplacement(
  db: Database,
  agentId: string,
  workspaceId: string,
): Promise<{ predecessorId: string; contextKey: string } | null> {
  const activeTasks = await db
    .select({
      id: agentTaskQueue.id,
      conversationId: agentTaskQueue.conversationId,
      contextKey: agentTaskQueue.contextKey,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    );

  const steerableActive = activeTasks.filter((t) => t.contextKey);
  if (steerableActive.length === 0) return null;

  const contextKeys = steerableActive.map((t) => t.contextKey!);
  const queuedWithMatchingKeys = await db
    .select({
      conversationId: agentTaskQueue.conversationId,
      contextKey: agentTaskQueue.contextKey,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "queued"),
        inArray(agentTaskQueue.contextKey, contextKeys)
      )
    );

  const queuedSet = new Set(queuedWithMatchingKeys.map((q) => `${q.conversationId}:${q.contextKey}`));
  for (const active of steerableActive) {
    if (queuedSet.has(`${active.conversationId}:${active.contextKey}`)) {
      return { predecessorId: active.id, contextKey: active.contextKey! };
    }
  }
  return null;
}

export async function claimTask(db: Database, agentId: string, workspaceId: string) {
  // Step 1: Get conversations that have active (dispatched/running) tasks, with their context keys
  const activeTasks = await db
    .select({
      conversationId: agentTaskQueue.conversationId,
      contextKey: agentTaskQueue.contextKey,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    );

  // Conversations fully blocked (active task with null contextKey, or any active task)
  // Steering-eligible conversations have a non-null contextKey on the active task
  const blockedConvIds: string[] = [];
  const steerableConvContextKeys = new Map<string, string>(); // conversationId -> contextKey

  for (const t of activeTasks) {
    if (t.contextKey) {
      steerableConvContextKeys.set(t.conversationId, t.contextKey);
    } else {
      blockedConvIds.push(t.conversationId);
    }
  }

  // Step 2: Find queued tasks not in blocked conversations.
  // For steerable conversations, only allow if the queued task has the same non-null contextKey.
  const allBlockedConvIds = [...blockedConvIds];
  // Also block steerable conversations for the general query — we'll query them separately
  for (const convId of steerableConvContextKeys.keys()) {
    allBlockedConvIds.push(convId);
  }

  // Try non-steerable candidates first
  const candidateQuery = db
    .select({ id: agentTaskQueue.id })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "queued"),
        ...(allBlockedConvIds.length > 0
          ? [notInArray(agentTaskQueue.conversationId, allBlockedConvIds)]
          : [])
      )
    )
    .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
    .limit(1);

  let candidates = await candidateQuery;

  // If no non-steerable candidate, try steerable conversations (batched, capped at 50)
  if (candidates.length === 0 && steerableConvContextKeys.size > 0) {
    const steerConditions = [...steerableConvContextKeys.entries()].slice(0, 50).map(([convId, ctxKey]) =>
      and(
        eq(agentTaskQueue.conversationId, convId),
        eq(agentTaskQueue.contextKey, ctxKey),
      )
    );
    const steerCandidates = await db
      .select({ id: agentTaskQueue.id })
      .from(agentTaskQueue)
      .where(
        and(
          eq(agentTaskQueue.agentId, agentId),
          eq(agentTaskQueue.workspaceId, workspaceId),
          eq(agentTaskQueue.status, "queued"),
          or(...steerConditions),
        )
      )
      .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
      .limit(1);

    if (steerCandidates.length > 0) {
      candidates = steerCandidates;
    }
  }

  if (candidates.length === 0) return null;

  // Atomic claim: UPDATE WHERE status = 'queued' prevents double-dispatch.
  // If another runtime raced us to this candidate, retry with a fresh candidate.
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const targetId = attempt === 0
      ? candidates[0].id
      : (await db
          .select({ id: agentTaskQueue.id })
          .from(agentTaskQueue)
          .where(
            and(
              eq(agentTaskQueue.agentId, agentId),
              eq(agentTaskQueue.workspaceId, workspaceId),
              eq(agentTaskQueue.status, "queued"),
              ...(allBlockedConvIds.length > 0
                ? [notInArray(agentTaskQueue.conversationId, allBlockedConvIds)]
                : [])
            )
          )
          .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
          .limit(1)
          .then(r => r[0]?.id));

    if (!targetId) return null;

    const rows = await db
      .update(agentTaskQueue)
      .set({ status: "dispatched", dispatchedAt: now })
      .where(
        and(
          eq(agentTaskQueue.id, targetId),
          eq(agentTaskQueue.status, "queued")
        )
      )
      .returning();

    const row = rows[0];
    if (row) return ClaimedTaskRowSchema.parse(row);
  }
  return null;
}

export async function dispatchTaskById(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "dispatched", dispatchedAt: new Date().toISOString() })
    .where(
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.workspaceId, workspaceId), eq(agentTaskQueue.status, "queued"))
    )
    .returning();
  return rows[0] ? ClaimedTaskRowSchema.parse(rows[0]) : null;
}

export async function revertDispatchedToQueued(db: Database, id: string, workspaceId: string) {
  await db
    .update(agentTaskQueue)
    .set({ status: "queued", dispatchedAt: null })
    .where(
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.workspaceId, workspaceId), eq(agentTaskQueue.status, "dispatched"))
    );
}

export async function startTask(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "running", startedAt: new Date().toISOString() })
    .where(
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.workspaceId, workspaceId), eq(agentTaskQueue.status, "dispatched"))
    )
    .returning();
  return rows[0] ?? null;
}

export async function completeTask(
  db: Database,
  id: string,
  workspaceId: string,
  data: { result: unknown; sessionId: string | null }
) {
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "completed",
      completedAt: new Date().toISOString(),
      result: data.result,
      sessionId: data.sessionId,
    })
    .where(
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.workspaceId, workspaceId), eq(agentTaskQueue.status, "running"))
    )
    .returning();
  return rows[0] ?? null;
}

export async function failTask(
  db: Database,
  id: string,
  workspaceId: string,
  error: string
) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "failed", completedAt: new Date().toISOString(), error })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"])
      )
    )
    .returning();
  return rows[0] ?? null;
}


export async function listPendingTasksByRuntimes(
  db: Database,
  runtimeIds: string[],
  workspaceId: string
) {
  if (runtimeIds.length === 0) return [];
  return db
    .select()
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.runtimeId, runtimeIds),
        inArray(agentTaskQueue.status, ["queued", "dispatched"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt));
}

export async function hasPendingTaskForConversation(
  db: Database,
  conversationId: string
) {
  const rows = await db
    .select({ id: agentTaskQueue.id })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.conversationId, conversationId),
        inArray(agentTaskQueue.status, ["queued", "dispatched"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function supersedeTask(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "superseded", completedAt: new Date().toISOString() })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"])
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function markFailedAsSuperseded(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "superseded" })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "failed")
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function cancelTask(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"])
      )
    )
    .returning();
  return rows[0] ?? null;
}

const DEFAULT_STALE_SECONDS = Number(process.env.ALOOK_STALE_DISPATCH_TIMEOUT_S) || 20;

export async function failStaleDispatchedTasks(db: Database, workspaceId: string, staleSeconds = DEFAULT_STALE_SECONDS) {
  const threshold = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "timed out in dispatched state (daemon likely disconnected)",
    })
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "dispatched"),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
        lt(agentTaskQueue.dispatchedAt, threshold)
      )
    )
    .returning({ agentId: agentTaskQueue.agentId, workspaceId: agentTaskQueue.workspaceId, conversationId: agentTaskQueue.conversationId });
  return rows;
}

export async function deleteTasksByConversation(
  db: Database,
  conversationId: string,
  workspaceId: string
) {
  return db
    .delete(agentTaskQueue)
    .where(and(eq(agentTaskQueue.conversationId, conversationId), eq(agentTaskQueue.workspaceId, workspaceId)))
    .returning({ id: agentTaskQueue.id });
}

export async function cancelActiveTasksByConversation(
  db: Database,
  conversationId: string,
  workspaceId: string
) {
  return db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(
      and(
        eq(agentTaskQueue.conversationId, conversationId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"])
      )
    )
    .returning({ id: agentTaskQueue.id });
}

export async function countRunningTasks(db: Database, agentId: string, workspaceId: string, excludeTaskId?: string) {
  const conditions = [
    eq(agentTaskQueue.agentId, agentId),
    eq(agentTaskQueue.workspaceId, workspaceId),
    inArray(agentTaskQueue.status, ["dispatched", "running"]),
    ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
  ];
  if (excludeTaskId) {
    conditions.push(ne(agentTaskQueue.id, excludeTaskId));
  }
  const rows = await db
    .select({ value: count() })
    .from(agentTaskQueue)
    .where(and(...conditions));
  return Number(rows[0]?.value ?? 0);
}

export async function listActiveTaskCountsByWorkspace(
  db: Database,
  workspaceId: string
) {
  return db
    .select({
      agentId: agentTaskQueue.agentId,
      count: count(),
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .groupBy(agentTaskQueue.agentId)
    .limit(200);
}

export async function listActiveTasksByWorkspace(
  db: Database,
  workspaceId: string
) {
  return db
    .select({
      id: agentTaskQueue.id,
      agentId: agentTaskQueue.agentId,
      prompt: agentTaskQueue.prompt,
      status: agentTaskQueue.status,
      type: agentTaskQueue.type,
      conversationId: agentTaskQueue.conversationId,
      createdAt: agentTaskQueue.createdAt,
      channel: conversation.channel,
    })
    .from(agentTaskQueue)
    .leftJoin(conversation, eq(agentTaskQueue.conversationId, conversation.id))
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(50);
}

export async function listActiveTasksByAgent(
  db: Database,
  agentId: string,
  workspaceId: string
) {
  return db
    .select({
      id: agentTaskQueue.id,
      status: agentTaskQueue.status,
      type: agentTaskQueue.type,
      createdAt: agentTaskQueue.createdAt,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
    .limit(100);
}

export async function getActiveTaskByConversation(
  db: Database,
  conversationId: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.conversationId, conversationId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"]),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function claimKillTasks(
  db: Database,
  runtimeIds: string[],
  workspaceId: string,
  limit: number
) {
  if (runtimeIds.length === 0 || limit <= 0) return [];

  const candidates = await db
    .select({ id: agentTaskQueue.id })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
        eq(agentTaskQueue.status, "queued"),
        inArray(agentTaskQueue.runtimeId, runtimeIds)
      )
    )
    .orderBy(asc(agentTaskQueue.createdAt))
    .limit(limit);

  const ids = candidates.map(c => c.id);
  if (ids.length === 0) return [];

  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "dispatched", dispatchedAt: new Date().toISOString() })
    .where(
      and(
        inArray(agentTaskQueue.id, ids),
        eq(agentTaskQueue.status, "queued")
      )
    )
    .returning();
  return rows.map(r => ClaimedTaskRowSchema.parse(r));
}

const KILL_TASK_STALE_SECONDS = 90;

export async function failStaleKillTasks(db: Database, workspaceId: string) {
  const threshold = new Date(Date.now() - KILL_TASK_STALE_SECONDS * 1000).toISOString();
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "kill_task timed out (daemon likely offline)",
    })
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
        inArray(agentTaskQueue.status, ["queued", "dispatched"]),
        lt(sql`coalesce(${agentTaskQueue.dispatchedAt}, ${agentTaskQueue.createdAt})`, threshold)
      )
    )
    .returning({ id: agentTaskQueue.id });
  return rows;
}

const DEFAULT_STALE_RUNNING_SECONDS = Number(process.env.ALOOK_STALE_RUNNING_TIMEOUT_S) || 3600;

export async function failStaleRunningTasks(db: Database, workspaceId: string, staleSeconds = DEFAULT_STALE_RUNNING_SECONDS) {
  const threshold = new Date(Date.now() - staleSeconds * 1000).toISOString();

  const staleRows = await db
    .select({
      id: agentTaskQueue.id,
    })
    .from(agentTaskQueue)
    .leftJoin(taskMessage, eq(taskMessage.taskId, agentTaskQueue.id))
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "running"),
      )
    )
    .groupBy(agentTaskQueue.id)
    .having(
      sql`COALESCE(MAX(${taskMessage.createdAt}), ${agentTaskQueue.startedAt}) < ${threshold}`
    );

  if (staleRows.length === 0) return [];

  const staleIds = staleRows.map((r) => r.id);
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `timed out in running state (no message activity for ${Math.round(staleSeconds / 60)} minutes)`,
    })
    .where(and(inArray(agentTaskQueue.id, staleIds), eq(agentTaskQueue.status, "running")))
    .returning({ agentId: agentTaskQueue.agentId, workspaceId: agentTaskQueue.workspaceId, conversationId: agentTaskQueue.conversationId });
  return rows;
}

const DEFAULT_HISTORY_LIMIT = 30;

export async function listTaskHistory(
  db: Database,
  agentId: string,
  workspaceId: string,
  opts?: {
    limit?: number;
    before?: string;
    beforeId?: string;
    status?: string[];
    type?: string[];
  }
) {
  const limit = opts?.limit ?? DEFAULT_HISTORY_LIMIT;
  const conditions = [
    eq(agentTaskQueue.agentId, agentId),
    eq(agentTaskQueue.workspaceId, workspaceId),
    ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
  ];

  if (opts?.status && opts.status.length > 0) {
    conditions.push(inArray(agentTaskQueue.status, opts.status));
  }

  if (opts?.type && opts.type.length > 0) {
    conditions.push(inArray(agentTaskQueue.type, opts.type));
  }

  if (opts?.before) {
    const cursorCondition = opts.beforeId
      ? or(
          lt(agentTaskQueue.createdAt, opts.before),
          and(eq(agentTaskQueue.createdAt, opts.before), lt(agentTaskQueue.id, opts.beforeId))
        )
      : lt(agentTaskQueue.createdAt, opts.before);
    conditions.push(cursorCondition!);
  }

  const rows = await db
    .select({
      id: agentTaskQueue.id,
      agentId: agentTaskQueue.agentId,
      conversationId: agentTaskQueue.conversationId,
      workspaceId: agentTaskQueue.workspaceId,
      prompt: agentTaskQueue.prompt,
      type: agentTaskQueue.type,
      status: agentTaskQueue.status,
      createdAt: agentTaskQueue.createdAt,
      startedAt: agentTaskQueue.startedAt,
      completedAt: agentTaskQueue.completedAt,
      error: agentTaskQueue.error,
    })
    .from(agentTaskQueue)
    .where(and(...conditions))
    .orderBy(desc(agentTaskQueue.createdAt), desc(agentTaskQueue.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const tasks = hasMore ? rows.slice(0, limit) : rows;

  return { tasks: tasks.reverse(), hasMore };
}

export async function listTraces(
  db: Database,
  workspaceId: string,
  opts?: { status?: string; limit?: number; before?: string; multiAgent?: boolean; agentId?: string; channel?: string }
) {
  const limit = opts?.limit ?? 30;

  const conditions = [
    eq(agentTaskQueue.workspaceId, workspaceId),
    sql`${agentTaskQueue.traceId} IS NOT NULL`,
    sql`${agentTaskQueue.parentTaskId} IS NULL`,
    ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
  ];
  if (opts?.before) {
    conditions.push(lt(agentTaskQueue.createdAt, opts.before));
  }
  if (opts?.agentId) {
    conditions.push(eq(agentTaskQueue.agentId, opts.agentId));
  }
  if (opts?.channel) {
    conditions.push(eq(conversation.channel, opts.channel));
  }
  if (opts?.multiAgent) {
    const helperTask = alias(agentTaskQueue, "helper_task");
    conditions.push(
      exists(
        db.select()
          .from(helperTask)
          .where(
            and(
              eq(helperTask.workspaceId, workspaceId),
              eq(helperTask.traceId, agentTaskQueue.traceId),
              ne(helperTask.agentId, agentTaskQueue.agentId),
              ne(helperTask.type, TASK_TYPES.KILL_TASK),
            )
          )
      )
    );
  }

  // Push status filter to DB via EXISTS subqueries
  if (opts?.status) {
    const traceTask = alias(agentTaskQueue, "trace_task");
    if (opts.status === "active") {
      conditions.push(
        exists(
          db.select()
            .from(traceTask)
            .where(
              and(
                eq(traceTask.workspaceId, workspaceId),
                eq(traceTask.traceId, agentTaskQueue.traceId),
                ne(traceTask.type, TASK_TYPES.KILL_TASK),
                inArray(traceTask.status, ["queued", "dispatched", "running"])
              )
            )
        )
      );
    } else if (opts.status === "completed") {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${agentTaskQueue} tt WHERE tt.workspace_id = ${workspaceId} AND tt.trace_id = ${agentTaskQueue.traceId} AND tt.type != ${TASK_TYPES.KILL_TASK} AND tt.status IN ('queued', 'dispatched', 'running', 'failed'))`
      );
    } else if (opts.status === "failed") {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${agentTaskQueue} tt WHERE tt.workspace_id = ${workspaceId} AND tt.trace_id = ${agentTaskQueue.traceId} AND tt.type != ${TASK_TYPES.KILL_TASK} AND tt.status IN ('queued', 'dispatched', 'running'))`
      );
      const failedTask = alias(agentTaskQueue, "failed_task");
      conditions.push(
        exists(
          db.select()
            .from(failedTask)
            .where(
              and(
                eq(failedTask.workspaceId, workspaceId),
                eq(failedTask.traceId, agentTaskQueue.traceId),
                ne(failedTask.type, TASK_TYPES.KILL_TASK),
                eq(failedTask.status, "failed")
              )
            )
        )
      );
    }
  }

  const rootTasks = await db
    .select({
      id: agentTaskQueue.id,
      traceId: agentTaskQueue.traceId,
      agentId: agentTaskQueue.agentId,
      prompt: agentTaskQueue.prompt,
      createdAt: agentTaskQueue.createdAt,
      channel: conversation.channel,
    })
    .from(agentTaskQueue)
    .leftJoin(conversation, eq(agentTaskQueue.conversationId, conversation.id))
    .where(and(...conditions))
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(limit + 1);

  if (rootTasks.length === 0) return { traces: [], hasMore: false };

  const hasMore = rootTasks.length > limit;
  const roots = rootTasks.slice(0, limit);
  const traceIds = roots.map(r => r.traceId).filter((id): id is string => !!id);
  if (traceIds.length === 0) return { traces: [], hasMore: false };

  const allTasks = await db
    .select({
      traceId: agentTaskQueue.traceId,
      agentId: agentTaskQueue.agentId,
      status: agentTaskQueue.status,
      completedAt: agentTaskQueue.completedAt,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.traceId, traceIds),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
      )
    );

  const tasksByTrace = new Map<string, typeof allTasks>();
  for (const t of allTasks) {
    if (!t.traceId) continue;
    const arr = tasksByTrace.get(t.traceId) ?? [];
    arr.push(t);
    tasksByTrace.set(t.traceId, arr);
  }

  const traces: {
    traceId: string;
    rootPrompt: string;
    rootAgentId: string;
    helperAgentIds: string[];
    status: string;
    taskCount: number;
    startedAt: string;
    completedAt: string | null;
    channel: string;
  }[] = [];

  for (const root of roots) {
    const tasks = tasksByTrace.get(root.traceId!) ?? [];
    const helperIds = [...new Set(tasks.map(t => t.agentId).filter(id => id !== root.agentId))];

    const hasActive = tasks.some(t => ["queued", "dispatched", "running"].includes(t.status));
    const hasFailed = tasks.some(t => t.status === "failed");
    let traceStatus: string;
    if (hasActive) traceStatus = "active";
    else if (hasFailed) traceStatus = "failed";
    else traceStatus = "completed";

    const allTerminal = tasks.every(t => ["completed", "failed", "cancelled", "superseded"].includes(t.status));
    const completedAt = allTerminal
      ? tasks.reduce((max, t) => (t.completedAt && t.completedAt > (max ?? "")) ? t.completedAt : max, null as string | null)
      : null;

    traces.push({
      traceId: root.traceId!,
      rootPrompt: root.prompt,
      rootAgentId: root.agentId,
      helperAgentIds: helperIds,
      status: traceStatus,
      taskCount: tasks.length,
      startedAt: root.createdAt,
      completedAt,
      channel: root.channel ?? "default",
    });
  }

  return { traces, hasMore };
}

export async function getTraceAgentsByTaskIds(
  db: Database,
  taskIds: string[],
  workspaceId: string
): Promise<Map<string, string[]>> {
  if (taskIds.length === 0) return new Map();

  const taskTraces = await db
    .select({ id: agentTaskQueue.id, traceId: agentTaskQueue.traceId })
    .from(agentTaskQueue)
    .where(
      and(
        inArray(agentTaskQueue.id, taskIds),
        sql`${agentTaskQueue.traceId} IS NOT NULL`,
        eq(agentTaskQueue.workspaceId, workspaceId)
      )
    );

  const traceToTaskIds = new Map<string, string[]>();
  for (const row of taskTraces) {
    if (!row.traceId) continue;
    const arr = traceToTaskIds.get(row.traceId) ?? [];
    arr.push(row.id);
    traceToTaskIds.set(row.traceId, arr);
  }

  const traceIds = [...traceToTaskIds.keys()];
  if (traceIds.length === 0) return new Map();

  const traceAgents = await db
    .selectDistinct({
      traceId: agentTaskQueue.traceId,
      agentId: agentTaskQueue.agentId,
    })
    .from(agentTaskQueue)
    .where(
      and(
        inArray(agentTaskQueue.traceId, traceIds),
        eq(agentTaskQueue.workspaceId, workspaceId),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    );

  const agentsByTrace = new Map<string, Set<string>>();
  for (const row of traceAgents) {
    if (!row.traceId) continue;
    const set = agentsByTrace.get(row.traceId) ?? new Set();
    set.add(row.agentId);
    agentsByTrace.set(row.traceId, set);
  }

  const result = new Map<string, string[]>();
  for (const [traceId, origTaskIds] of traceToTaskIds) {
    const agents = [...(agentsByTrace.get(traceId) ?? [])];
    for (const taskId of origTaskIds) {
      result.set(taskId, agents);
    }
  }

  return result;
}

export async function getTraceTree(
  db: Database,
  traceId: string,
  workspaceId: string
) {
  return db
    .select({
      id: agentTaskQueue.id,
      agentId: agentTaskQueue.agentId,
      parentTaskId: agentTaskQueue.parentTaskId,
      prompt: agentTaskQueue.prompt,
      status: agentTaskQueue.status,
      type: agentTaskQueue.type,
      conversationId: agentTaskQueue.conversationId,
      createdAt: agentTaskQueue.createdAt,
      completedAt: agentTaskQueue.completedAt,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.traceId, traceId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK)
      )
    )
    .orderBy(asc(agentTaskQueue.createdAt));
}
