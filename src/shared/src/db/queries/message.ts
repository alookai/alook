import { eq, asc, desc, and, lt, gte, or, count } from "drizzle-orm";
import { message } from "../schema";
import type { Database } from "../index";

export async function createMessage(
  db: Database,
  data: {
    conversationId: string;
    role: string;
    content: string;
    taskId?: string | null;
    attachmentIds?: string | null;
    metadata?: string | null;
  }
) {
  const rows = await db
    .insert(message)
    .values({
      conversationId: data.conversationId,
      role: data.role,
      content: data.content,
      taskId: data.taskId ?? null,
      attachmentIds: data.attachmentIds ?? null,
      metadata: data.metadata ?? null,
    })
    .returning();
  return rows[0]!;
}

const DEFAULT_MESSAGE_LIMIT = 20;

export async function getNewestMessageId(
  db: Database,
  conversationId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.status, "active")))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function listMessages(
  db: Database,
  conversationId: string,
  opts?: { limit?: number; before?: string; beforeId?: string }
): Promise<{ messages: typeof message.$inferSelect[]; has_more: boolean }> {
  const limit = opts?.limit ?? DEFAULT_MESSAGE_LIMIT;
  const before = opts?.before;
  const beforeId = opts?.beforeId;

  if (before) {
    const cursorCondition = beforeId
      ? or(
          lt(message.createdAt, before),
          and(eq(message.createdAt, before), lt(message.id, beforeId))
        )
      : lt(message.createdAt, before);

    const rows = await db
      .select()
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          eq(message.status, "active"),
          cursorCondition
        )
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return { messages, has_more };
  }

  const rows = await db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "active")
      )
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  return { messages, has_more };
}

export async function getMessage(db: Database, id: string) {
  const rows = await db.select().from(message).where(eq(message.id, id));
  return rows[0] ?? null;
}

export async function createBufferedMessage(
  db: Database,
  data: {
    conversationId: string;
    content: string;
    attachmentIds?: string | null;
  }
) {
  const rows = await db
    .insert(message)
    .values({
      conversationId: data.conversationId,
      role: "user",
      content: data.content,
      status: "buffered",
      attachmentIds: data.attachmentIds ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function listBufferedMessages(db: Database, conversationId: string) {
  return db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "buffered")
      )
    )
    .orderBy(asc(message.createdAt), asc(message.id));
}

export async function activateNextBufferedMessage(db: Database, conversationId: string) {
  const candidates = await db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "buffered")
      )
    )
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(1);

  if (candidates.length === 0) return null;

  const target = candidates[0]!;
  const updated = await db
    .update(message)
    .set({ status: "active", createdAt: new Date(Date.now() + 1000).toISOString() })
    .where(and(eq(message.id, target.id), eq(message.status, "buffered")))
    .returning();

  return updated[0] ?? null;
}

export async function revertToBuffered(db: Database, id: string) {
  const rows = await db
    .update(message)
    .set({ status: "buffered" })
    .where(and(eq(message.id, id), eq(message.status, "active")))
    .returning();
  return rows[0] ?? null;
}

export async function deleteBufferedMessage(db: Database, id: string) {
  const rows = await db
    .delete(message)
    .where(and(eq(message.id, id), eq(message.status, "buffered")))
    .returning();
  return rows[0] ?? null;
}

export async function deleteAllBufferedMessages(db: Database, conversationId: string) {
  const rows = await db
    .delete(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "buffered")
      )
    )
    .returning();
  return rows;
}

export async function countBufferedMessages(db: Database, conversationId: string) {
  const rows = await db
    .select({ count: count(message.id) })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "buffered")
      )
    );
  return rows[0]?.count ?? 0;
}

export async function updateMessageTaskId(db: Database, messageId: string, taskId: string) {
  await db.update(message).set({ taskId }).where(eq(message.id, messageId));
}

export async function listMessagesAroundTask(
  db: Database,
  conversationId: string,
  taskId: string,
  limit = 15
) {
  const target = await db
    .select({ createdAt: message.createdAt })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.taskId, taskId),
        eq(message.status, "active")
      )
    )
    .orderBy(asc(message.createdAt))
    .limit(1);

  if (target.length === 0) return [];

  const pivot = target[0]!.createdAt;

  const [before, atAndAfter] = await Promise.all([
    db
      .select()
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          eq(message.status, "active"),
          lt(message.createdAt, pivot)
        )
      )
      .orderBy(desc(message.createdAt))
      .limit(limit),
    db
      .select()
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          eq(message.status, "active"),
          gte(message.createdAt, pivot)
        )
      )
      .orderBy(asc(message.createdAt))
      .limit(limit + 1),
  ]);

  return [...before.reverse(), ...atAndAfter];
}
