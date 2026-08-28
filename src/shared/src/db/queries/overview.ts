import { eq, and, count, desc, inArray, ne, sql } from "drizzle-orm";
import { emails, agentEmailAccount, agentTaskQueue, conversation } from "../schema";
import type { Database } from "../index";
import { TASK_TYPES } from "../../constants";
import { jsonTextSet } from "./_json-set";

export async function getEmailStatsByWorkspace(db: Database, workspaceId: string) {
  const [stats] = await db
    .select({
      inbound: sql<number>`sum(case when ${emails.direction} = 'inbound' then 1 else 0 end)`,
      outbound: sql<number>`sum(case when ${emails.direction} = 'outbound' then 1 else 0 end)`,
      unread: sql<number>`sum(case when ${emails.status} = 'unread' and ${emails.direction} = 'inbound' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${emails.isWhitelisted} = 0 and ${emails.direction} = 'inbound' then 1 else 0 end)`,
    })
    .from(emails)
    .where(eq(emails.workspaceId, workspaceId));

  return {
    inbound: Number(stats?.inbound ?? 0),
    outbound: Number(stats?.outbound ?? 0),
    unread: Number(stats?.unread ?? 0),
    rejected: Number(stats?.rejected ?? 0),
  };
}

export async function getEmailAccountsByWorkspace(db: Database, workspaceId: string) {
  return db
    .select({
      id: agentEmailAccount.id,
      agentId: agentEmailAccount.agentId,
      emailAddress: agentEmailAccount.emailAddress,
      status: agentEmailAccount.status,
      errorMessage: agentEmailAccount.errorMessage,
      lastSyncedAt: agentEmailAccount.lastSyncedAt,
    })
    .from(agentEmailAccount)
    .where(eq(agentEmailAccount.workspaceId, workspaceId));
}

export async function getTaskStatsByWorkspace(
  db: Database,
  workspaceId: string,
  todayStart: string
) {
  const staleThreshold = new Date(Date.now() - 3600 * 1000).toISOString();

  const [stats] = await db
    .select({
      completed: sql<number>`sum(case when ${agentTaskQueue.status} = 'completed' and ${agentTaskQueue.type} != ${TASK_TYPES.KILL_TASK} and ${agentTaskQueue.completedAt} >= ${todayStart} then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${agentTaskQueue.status} = 'failed' and ${agentTaskQueue.type} != ${TASK_TYPES.KILL_TASK} and ${agentTaskQueue.completedAt} >= ${todayStart} then 1 else 0 end)`,
      cancelled: sql<number>`sum(case when ${agentTaskQueue.status} = 'cancelled' and ${agentTaskQueue.type} != ${TASK_TYPES.KILL_TASK} and ${agentTaskQueue.completedAt} >= ${todayStart} then 1 else 0 end)`,
      queued: sql<number>`sum(case when ${agentTaskQueue.status} = 'queued' and ${agentTaskQueue.type} != ${TASK_TYPES.KILL_TASK} then 1 else 0 end)`,
      stale: sql<number>`sum(case when ${agentTaskQueue.status} = 'running' and ${agentTaskQueue.startedAt} < ${staleThreshold} then 1 else 0 end)`,
    })
    .from(agentTaskQueue)
    .where(eq(agentTaskQueue.workspaceId, workspaceId));

  return {
    completed: Number(stats?.completed ?? 0),
    failed: Number(stats?.failed ?? 0),
    cancelled: Number(stats?.cancelled ?? 0),
    queued: Number(stats?.queued ?? 0),
    stale: Number(stats?.stale ?? 0),
  };
}

export async function getRecentTerminalTasks(
  db: Database,
  workspaceId: string,
  visibleAgentIds: string[],
  limit = 15
) {
  if (visibleAgentIds.length === 0) return [];
  const agentIds = jsonTextSet(db, [...new Set(visibleAgentIds)]);
  return db
    .select({
      id: agentTaskQueue.id,
      agentId: agentTaskQueue.agentId,
      type: agentTaskQueue.type,
      status: agentTaskQueue.status,
      prompt: agentTaskQueue.prompt,
      createdAt: agentTaskQueue.createdAt,
      completedAt: agentTaskQueue.completedAt,
      error: agentTaskQueue.error,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.workspaceId, workspaceId),
        inArray(agentTaskQueue.agentId, agentIds),
        ne(agentTaskQueue.type, TASK_TYPES.KILL_TASK),
        inArray(agentTaskQueue.status, ["completed", "failed", "cancelled"])
      )
    )
    .orderBy(desc(agentTaskQueue.completedAt))
    .limit(limit);
}

export async function getConversationCountsByAgent(db: Database, workspaceId: string, visibleAgentIds: string[]) {
  if (visibleAgentIds.length === 0) return [];
  const agentIds = jsonTextSet(db, [...new Set(visibleAgentIds)]);
  return db
    .select({
      agentId: conversation.agentId,
      cnt: count(),
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        inArray(conversation.agentId, agentIds)
      )
    )
    .groupBy(conversation.agentId);
}
