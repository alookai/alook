import { eq, asc } from "drizzle-orm";
import { communityChannel } from "../../community-schema";
import type { Database } from "../../index";

export async function createChannel(
  db: Database,
  data: {
    serverId: string;
    categoryId?: string | null;
    name: string;
    type?: string;
    topic?: string;
  }
) {
  const rows = await db
    .insert(communityChannel)
    .values({
      serverId: data.serverId,
      categoryId: data.categoryId ?? null,
      name: data.name,
      type: data.type ?? "text",
      topic: data.topic ?? "",
    })
    .returning();
  return rows[0]!;
}

export async function getChannel(db: Database, channelId: string) {
  const rows = await db
    .select()
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId));
  return rows[0] ?? null;
}

export async function updateChannel(
  db: Database,
  channelId: string,
  data: {
    name?: string;
    topic?: string;
    categoryId?: string | null;
    forumTags?: string | null;
  }
) {
  const rows = await db
    .update(communityChannel)
    .set(data)
    .where(eq(communityChannel.id, channelId))
    .returning();
  return rows[0] ?? null;
}

export async function deleteChannel(db: Database, channelId: string) {
  const rows = await db
    .delete(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .returning();
  return rows[0] ?? null;
}

export async function listServerChannels(db: Database, serverId: string) {
  return db
    .select()
    .from(communityChannel)
    .where(eq(communityChannel.serverId, serverId))
    .orderBy(asc(communityChannel.position));
}

export async function reorderChannels(
  db: Database,
  serverId: string,
  channelIds: string[]
) {
  await (db as any).batch(
    channelIds.map((id, index) =>
      db
        .update(communityChannel)
        .set({ position: index })
        .where(eq(communityChannel.id, id))
    )
  );
}
