import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "../index";

export async function listUnreadConversations(
  db: Database,
  userId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string; types?: string[] }
) {
  const limit = opts?.limit ?? 30;
  const beforeClause = opts?.before
    ? sql`AND t.completed_at < ${opts.before}`
    : sql``;

  const types = opts?.types?.length ? opts.types : ["user_dm_message"];
  const typePlaceholders = sql.join(types.map(t => sql`${t}`), sql`, `);

  const rows = await db.all<{
    id: string;
    agent_id: string;
    title: string;
    channel: string;
    latest_response: string;
    latest_response_at: string;
    root_prompt: string | null;
    agent_name: string | null;
    agent_avatar_url: string | null;
    root_task_status: string | null;
    root_task_type: string | null;
  }>(sql`
    SELECT c.id,
           c.agent_id,
           c.title,
           c.channel,
           m_latest.content AS latest_response,
           t.completed_at AS latest_response_at,
           t.prompt AS root_prompt,
           a.name AS agent_name,
           a.avatar_url AS agent_avatar_url,
           t.status AS root_task_status,
           t.type AS root_task_type
    FROM agent_task_queue t
    INNER JOIN conversation c
      ON c.id = t.conversation_id
      AND c.user_id = ${userId}
      AND c.workspace_id = ${workspaceId}
    LEFT JOIN conversation_read_state crs
      ON crs.conversation_id = c.id AND crs.user_id = ${userId}
    INNER JOIN message m_latest
      ON m_latest.conversation_id = c.id
      AND m_latest.role = 'assistant'
      AND m_latest.status = 'active'
      AND m_latest.id = (
        SELECT id FROM message
        WHERE conversation_id = c.id
          AND role = 'assistant'
          AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      )
    LEFT JOIN agent a
      ON a.id = c.agent_id AND a.workspace_id = c.workspace_id
    WHERE t.workspace_id = ${workspaceId}
      AND t.parent_task_id IS NULL
      AND t.trace_id IS NOT NULL
      AND t.type IN (${typePlaceholders})
      AND t.status IN ('completed', 'failed')
      AND t.completed_at > COALESCE(crs.last_read_at, '1970-01-01T00:00:00.000Z')
      AND NOT (t.type = 'email_notification' AND COALESCE(json_extract(t.context, '$.isInternal'), 0) = 1)
      AND t.id = (
        SELECT id FROM agent_task_queue
        WHERE workspace_id = ${workspaceId}
          AND conversation_id = c.id
          AND parent_task_id IS NULL
          AND trace_id IS NOT NULL
          AND type IN (${typePlaceholders})
          AND status IN ('completed', 'failed')
          AND NOT (type = 'email_notification' AND COALESCE(json_extract(context, '$.isInternal'), 0) = 1)
        ORDER BY completed_at DESC LIMIT 1
      )
      ${beforeClause}
    ORDER BY t.completed_at DESC
    LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return { items, hasMore };
}

export async function getUnreadCount(
  db: Database,
  userId: string,
  workspaceId: string,
  types?: string[],
) {
  const validTypes = types?.length ? types : ["user_dm_message"];
  const typePlaceholders = sql.join(validTypes.map(t => sql`${t}`), sql`, `);

  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(DISTINCT t.conversation_id) AS count
    FROM agent_task_queue t
    INNER JOIN conversation c
      ON c.id = t.conversation_id
      AND c.user_id = ${userId}
      AND c.workspace_id = ${workspaceId}
    LEFT JOIN conversation_read_state crs
      ON crs.conversation_id = t.conversation_id AND crs.user_id = ${userId}
    WHERE t.workspace_id = ${workspaceId}
      AND t.parent_task_id IS NULL
      AND t.trace_id IS NOT NULL
      AND t.type IN (${typePlaceholders})
      AND t.status IN ('completed', 'failed')
      AND t.completed_at > COALESCE(crs.last_read_at, '1970-01-01T00:00:00.000Z')
      AND NOT (t.type = 'email_notification' AND COALESCE(json_extract(t.context, '$.isInternal'), 0) = 1)
  `);

  return rows[0]?.count ?? 0;
}

export async function markConversationRead(
  db: Database,
  userId: string,
  conversationId: string,
) {
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO conversation_read_state (id, conversation_id, user_id, last_read_at, created_at)
    VALUES (${nanoid()}, ${conversationId}, ${userId}, ${now}, ${now})
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET last_read_at = ${now}
  `);
}

export async function markAllConversationsRead(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO conversation_read_state (id, conversation_id, user_id, last_read_at, created_at)
    SELECT lower(hex(randomblob(11))), c.id, ${userId}, ${now}, ${now}
    FROM conversation c
    WHERE c.user_id = ${userId}
      AND c.workspace_id = ${workspaceId}
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET last_read_at = ${now}
  `);
}
