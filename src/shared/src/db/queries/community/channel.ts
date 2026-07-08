import { eq, and, asc, desc, isNull, max, inArray } from "drizzle-orm";
import {
  communityChannel,
  communityServerMember,
  communityMessage,
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

/**
 * `resolveTargetForMember`'s channel-name resolver: matches by ID or NAME
 * within one server, visibility-scoped to `userId`'s membership in that
 * server (same gate as `getChannelForMember`). Returns an ARRAY — like
 * `resolveServerByNameForMember`, ambiguity (2+ name matches) is not an
 * error; the caller returns a hint list (debt #5).
 */
export async function resolveChannelByNameForMember(
  db: Database,
  serverId: string,
  userId: string,
  nameOrId: string
) {
  const byId = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .where(and(eq(communityChannel.serverId, serverId), eq(communityChannel.id, nameOrId)));
  if (byId.length > 0) return byId.map(mapChannelRow);

  const byName = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .where(and(eq(communityChannel.serverId, serverId), eq(communityChannel.name, nameOrId)));
  return byName.map(mapChannelRow);
}

/**
 * Top-level channels (no threads — `parentChannelId IS NULL`, mirroring
 * `listServerChannels`) a bot can see via `listChannels`, scoped to server
 * membership only — same visibility rule the human server-channels route
 * uses (no extra private-category filter on read; decided in plan §7 v3).
 */
export async function listChannelsForMember(db: Database, serverId: string, userId: string) {
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
    .where(and(eq(communityChannel.serverId, serverId), isNull(communityChannel.parentChannelId)))
    .orderBy(asc(communityChannel.position));
  return rows.map(mapChannelRow);
}

/**
 * Look up an existing thread channel by its `(parentChannelId,
 * parentMessageId)` pair — the partial UNIQUE index this pair is enforced
 * against (migration 0052). Used by `resolveTargetForMember`'s thread
 * resolution (debt #10) both for the initial lookup and, on a
 * `createThreadChannel` unique-conflict, to fetch the concurrent winner.
 */
export async function getThreadChannelByParentMessage(
  db: Database,
  parentChannelId: string,
  parentMessageId: string
) {
  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(
      and(
        eq(communityChannel.parentChannelId, parentChannelId),
        eq(communityChannel.parentMessageId, parentMessageId)
      )
    );
  const row = rows[0];
  return row ? mapChannelRow(row) : null;
}

/**
 * Auto-create a thread channel rooted at `parentMessageId` inside
 * `parentChannelId` (debt #10 — threads ARE channels). `type: "thread"` is
 * REQUIRED — the column defaults to `"text"` otherwise, which would silently
 * hide the thread from the human web UI's `listChildChannels(..., {type:
 * "thread"})` query. `name` is NOT NULL with no human-supplied value here, so
 * it's derived from the parent message's own content: its first 40
 * characters, trimmed, falling back to the literal string `"Thread"` when
 * the parent message has no usable text (empty/attachment-only).
 *
 * Concurrency: relies on the partial UNIQUE index
 * `uq_community_channel_parent_message` (migration 0052) — callers must
 * catch the unique-conflict error and re-`SELECT` the winner; this function
 * does not retry internally (see `resolveTargetForMember`).
 */
export async function createThreadChannel(
  db: Database,
  parentChannelId: string,
  parentMessageId: string,
  creatorId: string
) {
  const [parentServer, parentMessage] = await Promise.all([
    db
      .select({ serverId: communityChannel.serverId })
      .from(communityChannel)
      .where(eq(communityChannel.id, parentChannelId)),
    db
      .select({ content: communityMessage.content })
      .from(communityMessage)
      .where(eq(communityMessage.id, parentMessageId)),
  ]);
  const serverId = parentServer[0]?.serverId;
  if (!serverId) throw new Error(`createThreadChannel: parent channel ${parentChannelId} not found`);

  const rawContent = parentMessage[0]?.content?.trim() ?? "";
  const name = rawContent.length > 0 ? rawContent.slice(0, 40) : "Thread";

  // `communityChannel` is typed as `SQLiteTableWithColumns<any>` (schema
  // file), so `.returning()` without an explicit column set loses all type
  // info. Return just the new id, then re-fetch through `getChannel`'s
  // properly-typed `CHANNEL_COLUMNS` select instead of casting `any`.
  const inserted = await db
    .insert(communityChannel)
    .values({
      serverId,
      name,
      type: "thread",
      parentChannelId,
      parentMessageId,
      creatorId,
    })
    .returning({ id: communityChannel.id });
  const created = await getChannel(db, inserted[0]!.id);
  if (!created) throw new Error(`createThreadChannel: failed to re-fetch created channel ${inserted[0]!.id}`);
  return created;
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
