import { eq, asc, desc, and, lt, or, count } from "drizzle-orm";
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
    })
    .returning();
  return rows[0]!;
}

const DEFAULT_MESSAGE_LIMIT = 20;

export async function listMessages(
  db: Database,
  conversationId: string,
  opts?: { limit?: number; before?: string; beforeId?: string }
) {
  const limit = opts?.limit ?? DEFAULT_MESSAGE_LIMIT;
  const before = opts?.before;
  const beforeId = opts?.beforeId;

  if (before) {
    // Compound cursor: (createdAt < before) OR (createdAt == before AND id < beforeId)
    // This avoids skipping messages with identical timestamps
    const cursorCondition = beforeId
      ? or(
          lt(message.createdAt, before),
          and(eq(message.createdAt, before), lt(message.id, beforeId))
        )
      : lt(message.createdAt, before);

    return db
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
      .limit(limit)
      .then((rows) => rows.reverse());
  }

  // No cursor: fetch the latest N messages in ASC order
  // We query DESC to get the most recent, then reverse for chronological order
  return db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.status, "active")
      )
    )
    .orderBy(desc(message.createdAt))
    .limit(limit)
    .then((rows) => rows.reverse());
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
