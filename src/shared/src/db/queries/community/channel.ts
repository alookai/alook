import { eq, and, asc, desc, isNull, max, inArray } from "drizzle-orm";
import {
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import { createLogger } from "../../../logger";

// Module-level logger — one tag per shared query module.
const log = createLogger({ service: "community-queries" });

// TEXT column at rest → string[] at the boundary. Null/empty is a clean read
// (empty tag set); a parse throw or non-array shape signals bit-rot.
function safeParseForumTags(raw: string | null, channelId: string): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn("forum_tags_parse_failed", { channelId, err });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.warn("forum_tags_not_array", { channelId });
    return [];
  }
  return parsed as string[];
}

// Column selection shared by every read query — keeps `forumTags` off the wire
// (renamed to `tags`) and hands each caller the same row shape.
const CHANNEL_COLUMNS = {
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
} as const;

function mapChannelRow<
  T extends { id: string; forumTags: string | null },
>(row: T): Omit<T, "forumTags"> & { tags: string[] } {
  const { forumTags, ...rest } = row;
  return { ...rest, tags: safeParseForumTags(forumTags, row.id) };
}

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
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId));
  const row = rows[0];
  return row ? mapChannelRow(row) : null;
}

export async function getChannelForMember(db: Database, channelId: string, userId: string) {
  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .where(eq(communityChannel.id, channelId));
  const row = rows[0];
  return row ? mapChannelRow(row) : null;
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
  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(and(eq(communityChannel.serverId, serverId), isNull(communityChannel.parentChannelId)))
    .orderBy(asc(communityChannel.position));
  return rows.map(mapChannelRow);
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
  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(and(...conditions))
    .orderBy(desc(communityChannel.lastMessageAt));
  return rows.map(mapChannelRow);
}

export async function reorderChannels(
  db: Database,
  serverId: string,
  channelIds: string[]
) {
  const statements = channelIds.map((id, index) =>
    db
      .update(communityChannel)
      .set({ position: index })
      .where(eq(communityChannel.id, id))
  );
  if (statements.length > 0) {
    await db.batch(statements as [typeof statements[0], ...typeof statements]);
  }
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
    .where(inArray(communityChannel.serverId, serverIds))
    .groupBy(communityChannel.serverId);
  return new Map(rows.filter((r) => r.latestAt).map((r) => [r.serverId, r.latestAt!]));
}

export async function getChannelsByIds(db: Database, channelIds: string[]) {
  if (channelIds.length === 0) return [];
  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(inArray(communityChannel.id, channelIds));
  return rows.map(mapChannelRow);
}
