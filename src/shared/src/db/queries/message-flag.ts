import { eq, and, sql } from "drizzle-orm";
import { messageFlag, message, conversation } from "../schema";
import type { Database } from "../index";

export async function getMessageWorkspaceId(
  db: Database,
  messageId: string
): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: conversation.workspaceId })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(eq(message.id, messageId))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
}

export async function flagMessage(
  db: Database,
  data: { messageId: string; userId: string; workspaceId: string }
) {
  const rows = await db
    .insert(messageFlag)
    .values(data)
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function unflagMessage(
  db: Database,
  messageId: string,
  userId: string,
  workspaceId: string
) {
  const rows = await db
    .delete(messageFlag)
    .where(
      and(
        eq(messageFlag.messageId, messageId),
        eq(messageFlag.userId, userId),
        eq(messageFlag.workspaceId, workspaceId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function listFlaggedMessages(
  db: Database,
  userId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string }
) {
  const limit = opts?.limit ?? 30;
  const beforeClause = opts?.before
    ? sql`AND mf.created_at < ${opts.before}`
    : sql``;

  const rows = await db.all<{
    id: string;
    message_id: string;
    message_content: string;
    message_role: string;
    message_created_at: string;
    conversation_id: string;
    conversation_title: string;
    agent_id: string;
    agent_name: string | null;
    agent_avatar_url: string | null;
    flagged_at: string;
  }>(sql`
    SELECT
      mf.id,
      mf.message_id,
      m.content AS message_content,
      m.role AS message_role,
      m.created_at AS message_created_at,
      c.id AS conversation_id,
      c.title AS conversation_title,
      c.agent_id,
      a.name AS agent_name,
      a.avatar_url AS agent_avatar_url,
      mf.created_at AS flagged_at
    FROM message_flag mf
    INNER JOIN message m ON m.id = mf.message_id
    INNER JOIN conversation c ON c.id = m.conversation_id
    LEFT JOIN agent a ON a.id = c.agent_id AND a.workspace_id = c.workspace_id
    WHERE mf.user_id = ${userId}
      AND mf.workspace_id = ${workspaceId}
      ${beforeClause}
    ORDER BY mf.created_at DESC
    LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return { items, hasMore };
}

export async function getFlaggedCount(
  db: Database,
  userId: string,
  workspaceId: string
) {
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(messageFlag)
    .where(
      and(
        eq(messageFlag.userId, userId),
        eq(messageFlag.workspaceId, workspaceId)
      )
    );
  return rows[0]?.count ?? 0;
}

export async function listFlaggedMessageIds(
  db: Database,
  userId: string,
  workspaceId: string,
  conversationId: string
) {
  const rows = await db
    .select({ messageId: messageFlag.messageId })
    .from(messageFlag)
    .innerJoin(message, eq(message.id, messageFlag.messageId))
    .where(
      and(
        eq(messageFlag.userId, userId),
        eq(messageFlag.workspaceId, workspaceId),
        eq(message.conversationId, conversationId)
      )
    );
  return rows.map((r) => r.messageId);
}
