import { eq, and, or, asc, desc, isNull, isNotNull, max, inArray, count } from "drizzle-orm";
import {
  communityChannel,
  communityCategory,
  communityChannelMember,
  communityServerMember,
  communityMessage,
} from "../../community-schema";
import type { Database } from "../../index";
import { createLogger } from "../../../logger";
import { canManageServer, canSeePrivateChannel } from "../../../utils/community-roles";

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

/**
 * Fetch a channel scoped to what `userId` may READ/POST — the read/post gate
 * used by every message-scoped route. Server membership is the base gate
 * (inner join); on top of that a channel in a PRIVATE category (or a thread
 * whose parent anchor is private) resolves only for a server admin/owner, the
 * anchor's creator, or a user with a `community_channel_member` row on the
 * anchor. Public/uncategorized channels resolve for any server member. Returns
 * null when the caller can't see it. Scope-first (AGENTS.md): the visibility
 * predicate is in SQL, not a post-fetch check.
 */
export async function getChannelForMember(db: Database, channelId: string, userId: string) {
  const rows = await db
    .select({ ...CHANNEL_COLUMNS, memberRole: communityServerMember.role })
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
  if (!row) return null;
  const { memberRole, ...channelRow } = row;

  // Resolve the anchor (self for a top-level channel, parent for a thread) and
  // check its privacy + the viewer's access. Only runs the extra lookups when
  // the anchor is actually in a private category.
  const anchorId = channelRow.parentChannelId ?? channelRow.id;
  const anchor = await db
    .select({
      creatorId: communityChannel.creatorId,
      categoryPrivate: communityCategory.private,
    })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .where(eq(communityChannel.id, anchorId))
    .limit(1);

  const isPrivate = (anchor[0]?.categoryPrivate ?? 0) === 1;
  if (isPrivate) {
    const isCreator = anchor[0]?.creatorId === userId;
    // Skip the member-row lookup when role/creator already grant access.
    const isMember =
      canManageServer(memberRole) || isCreator
        ? false
        : await isChannelMember(db, anchorId, userId);
    if (!canSeePrivateChannel({ role: memberRole, isCreator, isChannelMember: isMember })) {
      return null;
    }
  }

  return mapChannelRow(channelRow);
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
 * `listServerChannels`) a viewer can see via `listChannels`, scoped to server
 * membership AND private-channel visibility: a channel in a PRIVATE category is
 * only returned if the viewer is an admin, the channel's creator, or has a
 * `community_channel_member` row for it. Public/uncategorized channels are
 * visible to any server member. This is the human-tree rule
 * (`listServerChannelsForViewer`) applied to the bot/agent surface.
 */
export async function listChannelsForMember(db: Database, serverId: string, userId: string) {
  const member = await db
    .select({ role: communityServerMember.role })
    .from(communityServerMember)
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .limit(1);
  if (member.length === 0) return [];
  return listServerChannelsForViewer(db, serverId, userId, {
    isAdmin: canManageServer(member[0]!.role),
  });
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
      .select({
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      })
      .from(communityChannel)
      .where(eq(communityChannel.id, parentChannelId)),
    db
      .select({ content: communityMessage.content })
      .from(communityMessage)
      .where(eq(communityMessage.id, parentMessageId)),
  ]);
  const serverId = parentServer[0]?.serverId;
  if (!serverId) throw new Error(`createThreadChannel: parent channel ${parentChannelId} not found`);

  // A thread may only root on a TOP-LEVEL channel. Rooting on a child channel
  // (a forum post, or another thread) would make this a grandchild whose
  // privacy the single-level anchor climb can't resolve — it would read the
  // child's own `categoryId` (always NULL) as public and leak a private
  // forum's thread server-wide. Single chokepoint for every caller (web
  // threads route, agent send/resolve auto-thread, future callers).
  if (parentServer[0]?.parentChannelId) {
    throw new Error(
      `createThreadChannel: cannot root a thread on child channel ${parentChannelId}`
    );
  }

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

// ---------------------------------------------------------------------------
// Private-channel membership + visibility
// (plans/channel-category-role-permissions.md)
// ---------------------------------------------------------------------------

/**
 * A channel is PRIVATE when its (anchor's) category has `private = 1`.
 * Uncategorized channels (`categoryId IS NULL`) and channels in public
 * categories are both PUBLIC. Climbs `parentChannelId` first so a thread
 * inherits its parent's privacy (a thread's own `categoryId` is always NULL).
 */
export async function isChannelPrivate(db: Database, channelId: string): Promise<boolean> {
  const target = await db
    .select({
      id: communityChannel.id,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  if (target.length === 0) return false;
  const anchorId = target[0]!.parentChannelId ?? target[0]!.id;

  const rows = await db
    .select({ private: communityCategory.private })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .where(eq(communityChannel.id, anchorId))
    .limit(1);
  return (rows[0]?.private ?? 0) === 1;
}

export async function createChannelMember(
  db: Database,
  data: { channelId: string; userId: string; addedBy?: string | null }
) {
  const rows = await db
    .insert(communityChannelMember)
    .values({
      channelId: data.channelId,
      userId: data.userId,
      addedBy: data.addedBy ?? null,
    })
    .onConflictDoNothing({
      target: [communityChannelMember.channelId, communityChannelMember.userId],
    })
    .returning();
  return rows[0] ?? null;
}

export async function deleteChannelMember(
  db: Database,
  channelId: string,
  userId: string
) {
  const rows = await db
    .delete(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, channelId),
        eq(communityChannelMember.userId, userId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Members explicitly added to a channel, joined to `user` for display. Scoped
 * to one channel id — cross-channel ids never resolve.
 */
export async function listChannelMembers(db: Database, channelId: string) {
  return db
    .select({
      id: communityChannelMember.id,
      channelId: communityChannelMember.channelId,
      userId: communityChannelMember.userId,
      addedBy: communityChannelMember.addedBy,
      addedAt: communityChannelMember.addedAt,
    })
    .from(communityChannelMember)
    .where(eq(communityChannelMember.channelId, channelId))
    .orderBy(asc(communityChannelMember.addedAt));
}

export async function listChannelMemberUserIds(
  db: Database,
  channelId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityChannelMember.userId })
    .from(communityChannelMember)
    .where(eq(communityChannelMember.channelId, channelId));
  return rows.map((r) => r.userId);
}

export async function isChannelMember(
  db: Database,
  channelId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityChannelMember.id })
    .from(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, channelId),
        eq(communityChannelMember.userId, userId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function getChannelMemberCount(
  db: Database,
  channelId: string
): Promise<number> {
  const rows = await db
    .select({ cnt: count() })
    .from(communityChannelMember)
    .where(eq(communityChannelMember.channelId, channelId));
  return rows[0]?.cnt ?? 0;
}

export async function countChannelsInCategory(
  db: Database,
  categoryId: string
): Promise<number> {
  const rows = await db
    .select({ cnt: count() })
    .from(communityChannel)
    .where(eq(communityChannel.categoryId, categoryId));
  return rows[0]?.cnt ?? 0;
}

/**
 * The full recipient audience for a PRIVATE channel: explicit members ∪ the
 * anchor channel's creator ∪ every server admin/owner. Resolves the anchor
 * first (a thread — `parentChannelId` set — inherits its parent's audience).
 * Only meaningful for a private anchor; callers guard on `isChannelPrivate`
 * first (fan-out short-circuits public channels to `listMemberUserIds` and
 * never calls this). Called on a public/uncategorized anchor it would return
 * just admins + creator, NOT all members — do not use it as a public-channel
 * recipient resolver.
 */
export async function getPrivateChannelAudienceUserIds(
  db: Database,
  channelId: string
): Promise<string[]> {
  const target = await db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  if (target.length === 0) return [];
  const anchorId = target[0]!.parentChannelId ?? target[0]!.id;
  const serverId = target[0]!.serverId;

  // Anchor row: creator + its category privacy.
  const anchor = await db
    .select({
      creatorId: communityChannel.creatorId,
      categoryPrivate: communityCategory.private,
    })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .where(eq(communityChannel.id, anchorId))
    .limit(1);
  if (anchor.length === 0) return [];

  // Server admins/owner always belong to the audience.
  const admins = await db
    .select({ userId: communityServerMember.userId })
    .from(communityServerMember)
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        or(
          eq(communityServerMember.role, "owner"),
          eq(communityServerMember.role, "admin")
        )
      )
    );
  const members = await listChannelMemberUserIds(db, anchorId);

  const set = new Set<string>();
  for (const a of admins) set.add(a.userId);
  for (const m of members) set.add(m);
  if (anchor[0]!.creatorId) set.add(anchor[0]!.creatorId as string);
  return [...set];
}

/**
 * Top-level channels a viewer may SEE in a server (backs the server-detail
 * tree). Rule, all in SQL (no JS post-filter):
 *   - admin/owner → every top-level channel.
 *   - otherwise → all public/uncategorized channels, PLUS private-category
 *     channels where the viewer is the creator OR has a member row.
 * `parentChannelId IS NULL` (threads excluded, mirroring `listServerChannels`).
 */
export async function listServerChannelsForViewer(
  db: Database,
  serverId: string,
  userId: string,
  opts: { isAdmin: boolean }
) {
  const base = and(
    eq(communityChannel.serverId, serverId),
    isNull(communityChannel.parentChannelId)
  );

  if (opts.isAdmin) {
    const rows = await db
      .select(CHANNEL_COLUMNS)
      .from(communityChannel)
      .where(base)
      .orderBy(asc(communityChannel.position));
    return rows.map(mapChannelRow);
  }

  const rows = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .leftJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.userId, userId)
      )
    )
    .where(
      and(
        base,
        or(
          // public / uncategorized
          isNull(communityChannel.categoryId),
          eq(communityCategory.private, 0),
          // private but visible to this viewer
          eq(communityChannel.creatorId, userId),
          isNotNull(communityChannelMember.id)
        )
      )
    )
    .orderBy(asc(communityChannel.position));
  return rows.map(mapChannelRow);
}

/**
 * The set of channel ids (top-level AND child/thread channels) a viewer may
 * see — backs read-path scoping for search / inbox / mark-all-read / mentions.
 * A thread inherits its parent's visibility, so it's included iff its
 * `parentChannelId` is in the visible top-level set. Scoping is done entirely
 * in SQL (the second query is scoped by the first's id set via `inArray`) —
 * no fetch-all-then-filter-in-JS leak.
 */
export async function listVisibleChannelIds(
  db: Database,
  serverId: string,
  userId: string,
  opts: { isAdmin: boolean }
): Promise<string[]> {
  if (opts.isAdmin) {
    const rows = await db
      .select({ id: communityChannel.id })
      .from(communityChannel)
      .where(eq(communityChannel.serverId, serverId));
    return rows.map((r) => r.id);
  }

  // Visible TOP-LEVEL channels: public/uncategorized ∪ private-where-viewer-is
  // creator-or-member.
  const topLevel = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .leftJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.userId, userId)
      )
    )
    .where(
      and(
        eq(communityChannel.serverId, serverId),
        isNull(communityChannel.parentChannelId),
        or(
          isNull(communityChannel.categoryId),
          eq(communityCategory.private, 0),
          eq(communityChannel.creatorId, userId),
          isNotNull(communityChannelMember.id)
        )
      )
    );
  const topLevelIds = topLevel.map((r) => r.id);
  if (topLevelIds.length === 0) return [];

  // Threads inherit from their parent: include children of visible top-level
  // channels (scoped by the id set — SQL, not JS). No `type` filter on the
  // children subquery, so forum_posts are covered alongside threads.
  const children = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(
      and(
        eq(communityChannel.serverId, serverId),
        inArray(communityChannel.parentChannelId, topLevelIds)
      )
    );
  return [...topLevelIds, ...children.map((r) => r.id)];
}

/**
 * Cross-server sibling of `listVisibleChannelIds` — every channel id (top-level
 * AND child/thread/forum-post) a viewer may see across ALL of their servers, in
 * a handful of queries instead of an N+1 loop-per-server. Backs the inbox
 * consumers (unread + mentions + mark-all), which span every server the viewer
 * belongs to.
 *
 * Same rule as the per-server form: admin/owner sees every channel in that
 * server; a non-admin sees public/uncategorized channels plus private-category
 * channels where they're the creator or have a member row. A child inherits its
 * parent's visibility (included iff its `parentChannelId` is in the visible
 * top-level set). Scoping is entirely in SQL.
 *
 * Bound-parameter ceiling (accepted risk): a viewer across many large servers
 * can produce a big id set; feeding it whole into a downstream `inArray`
 * approaches SQLite's bound-param limit. Same unchunked pattern as
 * `searchMessagesInServer` (single-server there, larger here). Chunk only if it
 * proves a real limit in practice.
 */
export async function listVisibleChannelIdsForUser(
  db: Database,
  userId: string
): Promise<string[]> {
  const memberships = await db
    .select({
      serverId: communityServerMember.serverId,
      role: communityServerMember.role,
    })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId));
  if (memberships.length === 0) return [];

  const adminServerIds: string[] = [];
  const memberServerIds: string[] = [];
  for (const m of memberships) {
    if (canManageServer(m.role)) adminServerIds.push(m.serverId);
    else memberServerIds.push(m.serverId);
  }

  const topLevelIds: string[] = [];

  // Admin servers: every top-level channel, no privacy filter.
  if (adminServerIds.length > 0) {
    const rows = await db
      .select({ id: communityChannel.id })
      .from(communityChannel)
      .where(
        and(
          inArray(communityChannel.serverId, adminServerIds),
          isNull(communityChannel.parentChannelId)
        )
      );
    for (const r of rows) topLevelIds.push(r.id);
  }

  // Member (non-admin) servers: public/uncategorized ∪ private-where-viewer-is
  // creator-or-member.
  if (memberServerIds.length > 0) {
    const rows = await db
      .select({ id: communityChannel.id })
      .from(communityChannel)
      .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
      .leftJoin(
        communityChannelMember,
        and(
          eq(communityChannelMember.channelId, communityChannel.id),
          eq(communityChannelMember.userId, userId)
        )
      )
      .where(
        and(
          inArray(communityChannel.serverId, memberServerIds),
          isNull(communityChannel.parentChannelId),
          or(
            isNull(communityChannel.categoryId),
            eq(communityCategory.private, 0),
            eq(communityChannel.creatorId, userId),
            isNotNull(communityChannelMember.id)
          )
        )
      );
    for (const r of rows) topLevelIds.push(r.id);
  }

  if (topLevelIds.length === 0) return [];

  const children = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(inArray(communityChannel.parentChannelId, topLevelIds));
  return [...topLevelIds, ...children.map((r) => r.id)];
}

/**
 * Single joined row backing `requireChannelAccess` — resolves in ONE round
 * trip everything the access predicate needs: the target channel, its anchor
 * (self when top-level, parent when a thread), the anchor's category privacy,
 * the viewer's server-member role, and whether the viewer has a member row on
 * the anchor. Returns null when the channel doesn't exist OR the viewer isn't
 * a server member (the membership gate). `role`/`memberFlag` reflect the
 * anchor's server.
 */
export async function resolveChannelAccessContext(
  db: Database,
  channelId: string,
  userId: string
) {
  const target = await db
    .select(CHANNEL_COLUMNS)
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  if (target.length === 0) return null;
  const channel = mapChannelRow(target[0]!);
  const anchorId = channel.parentChannelId ?? channel.id;

  // Server-membership gate against the target's server.
  const member = await db
    .select({ role: communityServerMember.role })
    .from(communityServerMember)
    .where(
      and(
        eq(communityServerMember.serverId, channel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .limit(1);
  if (member.length === 0) return null;

  const anchorRows =
    anchorId === channel.id
      ? [target[0]!]
      : await db
          .select(CHANNEL_COLUMNS)
          .from(communityChannel)
          .where(eq(communityChannel.id, anchorId))
          .limit(1);
  if (anchorRows.length === 0) return null;
  const anchor = mapChannelRow(anchorRows[0]!);

  let categoryPrivate = 0;
  if (anchor.categoryId) {
    const cat = await db
      .select({ private: communityCategory.private })
      .from(communityCategory)
      .where(eq(communityCategory.id, anchor.categoryId))
      .limit(1);
    categoryPrivate = cat[0]?.private ?? 0;
  }

  const memberFlag =
    categoryPrivate === 1
      ? await isChannelMember(db, anchorId, userId)
      : false;

  return {
    channel,
    anchor,
    role: member[0]!.role,
    isPrivate: categoryPrivate === 1,
    isChannelMember: memberFlag,
  };
}
