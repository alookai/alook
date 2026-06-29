import { eq, and, asc, desc, isNull, max, inArray } from "drizzle-orm";
import { communityChannel, communityServerMember } from "../../community-schema";
import type { Database } from "../../index";

export async function createChannel(
  db: Database,
  data: {
    serverId: string;
    categoryId?: string | null;
    name: string;
    type?: string;
    topic?: string;
    parentChannelId?: string | null;
    creatorId?: string | null;
    parentMessageId?: string | null;
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
      parentChannelId: data.parentChannelId ?? null,
      creatorId: data.creatorId ?? null,
      parentMessageId: data.parentMessageId ?? null,
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

export async function getChannelForMember(db: Database, channelId: string, userId: string) {
  const rows = await db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      categoryId: communityChannel.categoryId,
      name: communityChannel.name,
      type: communityChannel.type,
      topic: communityChannel.topic,
      position: communityChannel.position,
      forumTags: communityChannel.forumTags,
      parentChannelId: communityChannel.parentChannelId,
      creatorId: communityChannel.creatorId,
      messageCount: communityChannel.messageCount,
      archived: communityChannel.archived,
      parentMessageId: communityChannel.parentMessageId,
      lastMessageAt: communityChannel.lastMessageAt,
      createdAt: communityChannel.createdAt,
    })
    .from(communityChannel)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
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
    archived?: number;
    lastMessageAt?: string;
    messageCount?: number;
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
    .where(and(eq(communityChannel.serverId, serverId), isNull(communityChannel.parentChannelId)))
    .orderBy(asc(communityChannel.position));
}

export async function listChildChannels(
  db: Database,
  parentChannelId: string,
  opts?: { archived?: boolean; type?: string }
) {
  const conditions = [eq(communityChannel.parentChannelId, parentChannelId)];
  if (opts?.archived !== undefined) {
    conditions.push(eq(communityChannel.archived, opts.archived ? 1 : 0));
  }
  if (opts?.type) {
    conditions.push(eq(communityChannel.type, opts.type));
  }
  return db
    .select()
    .from(communityChannel)
    .where(and(...conditions))
    .orderBy(desc(communityChannel.lastMessageAt));
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

export async function getServersLastActivity(
  db: Database,
  serverIds: string[]
): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map();
  const rows = await db
    .select({
      serverId: communityChannel.serverId,
      latestAt: max(communityChannel.lastMessageAt),
    })
    .from(communityChannel)
    .where(and(
      inArray(communityChannel.serverId, serverIds),
      isNull(communityChannel.parentChannelId),
    ))
    .groupBy(communityChannel.serverId);
  return new Map(rows.filter((r) => r.latestAt).map((r) => [r.serverId, r.latestAt!]));
}
