import { eq, and, desc, asc, inArray, notInArray, ne, count, lt, or, sql } from "drizzle-orm";
import { agentTaskQueue, taskMessage } from "../schema";
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
    })
    .returning();
  return rows[0]!;
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

  for (const active of activeTasks) {
    if (!active.contextKey) continue;
    const candidates = await db
      .select({ id: agentTaskQueue.id })
      .from(agentTaskQueue)
      .where(
        and(
          eq(agentTaskQueue.agentId, agentId),
          eq(agentTaskQueue.workspaceId, workspaceId),
          eq(agentTaskQueue.status, "queued"),
          eq(agentTaskQueue.conversationId, active.conversationId),
          eq(agentTaskQueue.contextKey, active.contextKey)
        )
      )
      .limit(1);

    if (candidates.length > 0) {
      return { predecessorId: active.id, contextKey: active.contextKey };
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

  // If no non-steerable candidate, try steerable conversations
  if (candidates.length === 0 && steerableConvContextKeys.size > 0) {
    for (const [convId, activeContextKey] of steerableConvContextKeys) {
      const steerCandidates = await db
        .select({ id: agentTaskQueue.id })
        .from(agentTaskQueue)
        .where(
          and(
            eq(agentTaskQueue.agentId, agentId),
            eq(agentTaskQueue.workspaceId, workspaceId),
            eq(agentTaskQueue.status, "queued"),
            eq(agentTaskQueue.conversationId, convId),
            eq(agentTaskQueue.contextKey, activeContextKey)
          )
        )
        .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
        .limit(1);

      if (steerCandidates.length > 0) {
        candidates = steerCandidates;
        break;
      }
    }
  }

  if (candidates.length === 0) return null;

  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "dispatched", dispatchedAt: new Date().toISOString() })
    .where(
      and(
        eq(agentTaskQueue.id, candidates[0].id),
        eq(agentTaskQueue.status, "queued")
      )
    )
    .returning();

  const row = rows[0] ?? null;
  if (!row) return null;
  return ClaimedTaskRowSchema.parse(row);
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
    .groupBy(agentTaskQueue.agentId);
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

  const claimed = [];
  for (const candidate of candidates) {
    const rows = await db
      .update(agentTaskQueue)
      .set({ status: "dispatched", dispatchedAt: new Date().toISOString() })
      .where(
        and(
          eq(agentTaskQueue.id, candidate.id),
          eq(agentTaskQueue.status, "queued")
        )
      )
      .returning();
    const row = rows[0];
    if (row) claimed.push(ClaimedTaskRowSchema.parse(row));
  }
  return claimed;
}

const KILL_TASK_STALE_SECONDS = 30;

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
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `timed out in running state (no message activity for ${Math.round(staleSeconds / 60)} minutes)`,
    })
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "running"),
        lt(
          sql`coalesce(
            (select max(${taskMessage.createdAt}) from ${taskMessage} where ${taskMessage.taskId} = ${agentTaskQueue.id}),
            ${agentTaskQueue.startedAt}
          )`,
          threshold
        )
      )
    )
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
