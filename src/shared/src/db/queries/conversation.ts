import { eq, and, desc, ne, lt, sql, count as drizzleCount, inArray, isNull, isNotNull } from "drizzle-orm";
import { conversation, message } from "../schema";
import type { Database } from "../index";
import { TASK_TYPES, type TaskType } from "../../constants";


export async function createConversation(
  db: Database,
  data: {
    workspaceId: string;
    agentId: string;
    userId: string;
    title: string;
    type?: TaskType;
    channel?: string;
    parentMessageId?: string;
    threadTitle?: string;
  }
) {
  const rows = await db
    .insert(conversation)
    .values({
      workspaceId: data.workspaceId,
      agentId: data.agentId,
      userId: data.userId,
      title: data.title,
      type: data.type ?? TASK_TYPES.USER_DM_MESSAGE,
      channel: data.channel ?? "default",
      ...(data.parentMessageId ? { parentMessageId: data.parentMessageId, threadTitle: data.threadTitle ?? "" } : {}),
    })
    .returning();
  return rows[0]!;
}

export async function getConversation(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function getConversationsByIds(db: Database, ids: string[], workspaceId: string) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(conversation)
    .where(and(inArray(conversation.id, ids), eq(conversation.workspaceId, workspaceId)));
}

export async function listConversations(
  db: Database,
  workspaceId: string,
  userId: string,
  channel?: string
) {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.userId, userId),
    isNull(conversation.parentMessageId),
  ];
  if (channel) {
    conditions.push(eq(conversation.channel, channel));
  }
  return db
    .select()
    .from(conversation)
    .where(and(...conditions))
    .orderBy(desc(conversation.createdAt));
}

export async function listConversationsByAgent(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string,
  channel?: string
) {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.userId, userId),
    eq(conversation.agentId, agentId),
    isNull(conversation.parentMessageId),
  ];
  if (channel) {
    conditions.push(eq(conversation.channel, channel));
  }
  return db
    .select({
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      userId: conversation.userId,
      title: conversation.title,
      channel: conversation.channel,
      createdAt: conversation.createdAt,
      messageCount:
        sql<number>`COUNT(CASE WHEN ${message.status} = 'active' THEN 1 END)`.mapWith(Number),
    })
    .from(conversation)
    .leftJoin(message, eq(message.conversationId, conversation.id))
    .where(and(...conditions))
    .groupBy(conversation.id)
    .orderBy(desc(conversation.createdAt));
}

export async function updateConversationTitle(
  db: Database,
  id: string,
  title: string
) {
  const rows = await db
    .update(conversation)
    .set({ title })
    .where(and(eq(conversation.id, id), eq(conversation.title, "")))
    .returning();
  return rows[0] ?? null;
}

export async function getOrCreateAgentConversation(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string,
  channel?: string
) {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.userId, userId),
    eq(conversation.agentId, agentId),
    eq(conversation.type, TASK_TYPES.USER_DM_MESSAGE),
    isNull(conversation.parentMessageId),
  ];
  if (channel) {
    conditions.push(eq(conversation.channel, channel));
  }

  const rows = await db
    .select()
    .from(conversation)
    .where(and(...conditions))
    .orderBy(desc(conversation.createdAt))
    .limit(1);

  if (rows.length > 0) {
    return rows[0]!;
  }

  const created = await db
    .insert(conversation)
    .values({
      workspaceId,
      agentId,
      userId,
      title: "",
      type: TASK_TYPES.USER_DM_MESSAGE,
      channel: channel ?? "default",
    })
    .returning();
  return created[0]!;
}

export async function deleteConversation(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .delete(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function listPreviousConversations(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string,
  excludeId: string,
  channel?: string,
  opts?: { limit?: number; before?: string }
) {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.userId, userId),
    eq(conversation.agentId, agentId),
    eq(conversation.type, TASK_TYPES.USER_DM_MESSAGE),
    ne(conversation.id, excludeId),
    isNull(conversation.parentMessageId),
  ];
  if (channel) {
    conditions.push(eq(conversation.channel, channel));
  }
  if (opts?.before) {
    conditions.push(lt(conversation.createdAt, opts.before));
  }
  const limit = opts?.limit ?? 10;
  return db
    .select({ id: conversation.id, createdAt: conversation.createdAt })
    .from(conversation)
    .where(and(...conditions))
    .orderBy(desc(conversation.createdAt))
    .limit(limit);
}

export async function getThreadByParentMessage(
  db: Database,
  parentMessageId: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.parentMessageId, parentMessageId),
        eq(conversation.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getThreadsByParentMessages(
  db: Database,
  workspaceId: string,
  parentMessageIds: string[]
) {
  if (parentMessageIds.length === 0) return [];
  return db
    .select({
      id: conversation.id,
      parentMessageId: conversation.parentMessageId,
      threadTitle: conversation.threadTitle,
      createdAt: conversation.createdAt,
      replyCount:
        sql<number>`COUNT(CASE WHEN ${message.status} = 'active' THEN 1 END)`.mapWith(Number),
      lastReplyAt:
        sql<string>`MAX(${message.createdAt})`,
    })
    .from(conversation)
    .leftJoin(message, eq(message.conversationId, conversation.id))
    .where(
      and(
        inArray(conversation.parentMessageId, parentMessageIds),
        eq(conversation.workspaceId, workspaceId)
      )
    )
    .groupBy(conversation.id);
}

export async function getThreadsByConversation(
  db: Database,
  workspaceId: string,
  conversationId: string
) {
  return db
    .select({
      id: conversation.id,
      parentMessageId: conversation.parentMessageId,
      threadTitle: conversation.threadTitle,
      createdAt: conversation.createdAt,
      replyCount:
        sql<number>`COUNT(CASE WHEN ${message.status} = 'active' THEN 1 END)`.mapWith(Number),
      lastReplyAt:
        sql<string>`MAX(${message.createdAt})`,
    })
    .from(conversation)
    .leftJoin(message, eq(message.conversationId, conversation.id))
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        sql`${conversation.parentMessageId} IN (SELECT id FROM message WHERE conversation_id = ${conversationId} AND status = 'active')`
      )
    )
    .groupBy(conversation.id);
}

export async function listThreadsByAgent(
  db: Database,
  workspaceId: string,
  agentId: string,
  opts?: { limit?: number; before?: string }
) {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.agentId, agentId),
    isNotNull(conversation.parentMessageId),
  ];
  if (opts?.before) {
    conditions.push(lt(conversation.createdAt, opts.before));
  }
  const limit = opts?.limit ?? 30;
  return db
    .select({
      id: conversation.id,
      parentMessageId: conversation.parentMessageId,
      threadTitle: conversation.threadTitle,
      createdAt: conversation.createdAt,
      replyCount:
        sql<number>`COUNT(CASE WHEN ${message.status} = 'active' THEN 1 END)`.mapWith(Number),
      lastReplyAt:
        sql<string>`MAX(${message.createdAt})`,
      lastReplyPreview:
        sql<string>`(SELECT SUBSTR(m2.content, 1, 60) FROM message m2 WHERE m2.conversation_id = ${conversation.id} AND m2.status = 'active' ORDER BY m2.created_at DESC LIMIT 1)`,
    })
    .from(conversation)
    .leftJoin(message, eq(message.conversationId, conversation.id))
    .where(and(...conditions))
    .groupBy(conversation.id)
    .orderBy(desc(sql`MAX(${message.createdAt})`))
    .limit(limit);
}

export async function hasPreviousConversations(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string,
  excludeId: string,
  channel?: string,
): Promise<boolean> {
  const conditions = [
    eq(conversation.workspaceId, workspaceId),
    eq(conversation.userId, userId),
    eq(conversation.agentId, agentId),
    eq(conversation.type, TASK_TYPES.USER_DM_MESSAGE),
    ne(conversation.id, excludeId),
    isNull(conversation.parentMessageId),
  ];
  if (channel) {
    conditions.push(eq(conversation.channel, channel));
  }
  const rows = await db
    .select({ exists: sql<number>`1` })
    .from(conversation)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}
