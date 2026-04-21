import { eq, and, desc, asc, inArray, notInArray, count, lt } from "drizzle-orm";
import { agentTaskQueue } from "../schema";
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

export async function claimTask(db: Database, agentId: string, workspaceId: string) {
  // Step 1: Get conversations that have active (dispatched/running) tasks
  const activeConversations = await db
    .select({ conversationId: agentTaskQueue.conversationId })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"])
      )
    );

  const activeConvIds = activeConversations.map((r) => r.conversationId);

  // Step 2: Find queued tasks not in those conversations
  const candidateQuery = db
    .select({ id: agentTaskQueue.id })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(agentTaskQueue.status, "queued"),
        ...(activeConvIds.length > 0
          ? [notInArray(agentTaskQueue.conversationId, activeConvIds)]
          : [])
      )
    )
    .orderBy(desc(agentTaskQueue.priority), asc(agentTaskQueue.createdAt))
    .limit(1);

  const candidates = await candidateQuery;

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

export async function startTask(db: Database, id: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "running", startedAt: new Date().toISOString() })
    .where(
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.status, "dispatched"))
    )
    .returning();
  return rows[0] ?? null;
}

export async function completeTask(
  db: Database,
  id: string,
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
      and(eq(agentTaskQueue.id, id), eq(agentTaskQueue.status, "running"))
    )
    .returning();
  return rows[0] ?? null;
}

export async function failTask(
  db: Database,
  id: string,
  error: string
) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "failed", completedAt: new Date().toISOString(), error })
    .where(
      and(
        eq(agentTaskQueue.id, id),
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
        inArray(agentTaskQueue.status, ["queued", "dispatched"])
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
        inArray(agentTaskQueue.status, ["queued", "dispatched"])
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function cancelTask(db: Database, id: string) {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(
      and(
        eq(agentTaskQueue.id, id),
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

export async function countRunningTasks(db: Database, agentId: string, workspaceId: string) {
  const rows = await db
    .select({ value: count() })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.status, ["dispatched", "running"])
      )
    );
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
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"])
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
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"])
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
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running"])
      )
    )
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
