import { eq, and, desc, count } from "drizzle-orm";
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

export async function listConversations(
  db: Database,
  workspaceId: string,
  userId: string
) {
  return db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.userId, userId)
      )
    )
    .orderBy(desc(conversation.createdAt));
}

export async function listConversationsByAgent(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string
) {
  return db
    .select({
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      messageCount: count(message.id).mapWith(Number),
    })
    .from(conversation)
    .leftJoin(message, and(eq(message.conversationId, conversation.id), eq(message.status, "active")))
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.userId, userId),
        eq(conversation.agentId, agentId)
      )
    )
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
  agentId: string
) {
  // Find the most recent user-DM conversation for this user+agent+workspace.
  // Email- and calendar-originated conversations share the same table but must
  // not surface as the agent's default chat — they have their own entry points.
  const rows = await db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.userId, userId),
        eq(conversation.agentId, agentId),
        eq(conversation.type, TASK_TYPES.USER_DM_MESSAGE)
      )
    )
    .orderBy(desc(conversation.createdAt))
    .limit(1);

  if (rows.length > 0) {
    return rows[0]!;
  }

  // No conversation exists — create one
  const created = await db
    .insert(conversation)
    .values({
      workspaceId,
      agentId,
      userId,
      title: "",
      type: TASK_TYPES.USER_DM_MESSAGE,
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
