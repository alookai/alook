import { eq, and, desc } from "drizzle-orm";
import { communityThread } from "../../community-schema";
import type { Database } from "../../index";

export async function createThread(
  db: Database,
  data: {
    channelId: string;
    parentMessageId?: string;
    name: string;
    kind?: string;
    tags?: string;
    creatorId?: string;
  }
) {
  const rows = await db
    .insert(communityThread)
    .values({
      channelId: data.channelId,
      parentMessageId: data.parentMessageId ?? null,
      name: data.name,
      kind: data.kind ?? "thread",
      tags: data.tags ?? null,
      creatorId: data.creatorId ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function getThread(db: Database, threadId: string) {
  const rows = await db
    .select()
    .from(communityThread)
    .where(eq(communityThread.id, threadId));
  return rows[0] ?? null;
}

export async function updateThread(
  db: Database,
  threadId: string,
  data: { name?: string; archived?: number; tags?: string }
) {
  const rows = await db
    .update(communityThread)
    .set(data)
    .where(eq(communityThread.id, threadId))
    .returning();
  return rows[0] ?? null;
}

export async function listChannelThreads(
  db: Database,
  channelId: string,
  opts?: { archived?: boolean }
) {
  const conditions: ReturnType<typeof eq>[] = [
    eq(communityThread.channelId, channelId),
  ];

  if (opts?.archived !== undefined) {
    conditions.push(eq(communityThread.archived, opts.archived ? 1 : 0));
  }

  return db
    .select()
    .from(communityThread)
    .where(and(...conditions))
    .orderBy(desc(communityThread.lastMessageAt));
}
