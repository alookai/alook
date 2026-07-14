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
import { canManageServer, canSeePrivateChannel, isForum, isForumPost } from "../../../utils/community-roles";

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
      categoryId: data.categoryId || null,
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

// Just the `type` of a channel ("text" | "forum" | "forum_post" | "thread" |
// null). A one-column probe for hot paths that only need to branch by type
// (e.g. fan-out routing a thread to its participant set). Returns null when the
// channel doesn't exist.
export async function getChannelType(
  db: Database,
  channelId: string
): Promise<string | null> {
  const rows = await db
    .select({ type: communityChannel.type })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  return rows[0]?.type ?? null;
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

  // Privacy anchor vs roster anchor (nested-membership model):
  //   - thread (`parentMessageId` set) → BOTH climb to the parent channel; a
  //     thread never narrows access below its channel.
  //   - forum post (`type="forum_post"`) → privacy climbs to the forum (for the
  //     category flag), but the ROSTER is the post's OWN id + own `creatorId`.
  //   - top-level channel → self for both.
  // The single anchor query below reads the PRIVACY anchor (self for a
  // post/channel, parent for a thread) and its creator. For a post the roster
  // creator is the post's own (already in `channelRow`, no extra query); the
  // roster member-row lookup targets `rosterAnchorId`.
  const isPost = isForumPost(channelRow.type);
  const privacyAnchorId = channelRow.parentChannelId ?? channelRow.id;
  const rosterAnchorId = isPost ? channelRow.id : privacyAnchorId;

  const anchor = await db
    .select({
      creatorId: communityChannel.creatorId,
      categoryPrivate: communityCategory.private,
    })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .where(eq(communityChannel.id, privacyAnchorId))
    .limit(1);

  const isPrivate = (anchor[0]?.categoryPrivate ?? 0) === 1;
  if (isPrivate) {
    // Roster creator: a post's own creator, else the privacy anchor's creator
    // (for a top-level channel these coincide).
    const rosterCreatorId = isPost ? channelRow.creatorId : anchor[0]?.creatorId;
    const isCreator = rosterCreatorId === userId;
    // Membership: a FORUM's access is derived from its posts (member of any
    // child post); everything else checks a row on the roster anchor. NOTE:
    // admins have NO content privilege for private units — no role short-circuit
    // here; an admin must be the creator or an explicit member to see it.
    const channelIsForum = isForum(channelRow.type);
    const isMember = isCreator
      ? false
      : channelIsForum
        ? await isMemberOfAnyChildPost(db, channelRow.id, userId)
        : await isChannelMember(db, rosterAnchorId, userId);
    if (!canSeePrivateChannel({ isCreator, isChannelMember: isMember })) {
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
  return listServerChannelsForViewer(db, serverId, userId);
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

// Of the given channel ids, which ones the user has an explicit member row on.
// Batch form of `isChannelMember` — used to filter a private forum's posts to
// the ones the viewer belongs to without an N+1 loop.
export async function listChannelIdsWithMember(
  db: Database,
  channelIds: string[],
  userId: string
): Promise<string[]> {
  if (channelIds.length === 0) return [];
  const rows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .where(
      and(
        inArray(communityChannelMember.channelId, channelIds),
        eq(communityChannelMember.userId, userId)
      )
    );
  return rows.map((r) => r.channelId);
}

// Does the user have access to a FORUM via any of its posts? Forum access is
// derived (nested-membership model): a user sees a private forum iff they
// created it, or are the creator/an explicit member of at least one child post.
// Admins are handled by the caller (role check) before this runs.
export async function isMemberOfAnyChildPost(
  db: Database,
  forumId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .leftJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.userId, userId)
      )
    )
    .where(
      and(
        eq(communityChannel.parentChannelId, forumId),
        or(
          eq(communityChannel.creatorId, userId),
          isNotNull(communityChannelMember.id)
        )
      )
    )
    .limit(1);
  return rows.length > 0;
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
 * unit's creator. Type-aware (nested-membership model). Resolves the anchor for
 * a thread (`parentChannelId` set inherits its parent's audience). Only
 * meaningful for a private anchor; callers guard on `isChannelPrivate` first
 * (fan-out short-circuits public channels to `listMemberUserIds` and never
 * calls this).
 *
 * NOTE: server admins/owner are NOT auto-included — an admin is in a private
 * audience only if they created it or were explicitly added, exactly like a
 * member. Admins have no implicit content access.
 */
export async function getPrivateChannelAudienceUserIds(
  db: Database,
  channelId: string
): Promise<string[]> {
  const target = await db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      type: communityChannel.type,
      creatorId: communityChannel.creatorId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  if (target.length === 0) return [];
  const type = target[0]!.type;

  const set = new Set<string>();

  // Nested-membership model — the roster depends on the unit type:
  //   - forum_post → the post's OWN explicit members ∪ its OWN creator (does
  //     NOT climb to the forum; a post is an access unit like a channel).
  //   - forum      → the UNION of its posts' audiences ∪ the forum creator
  //     (derived, read-only aggregation).
  //   - thread     → climbs to the parent channel's audience (a thread never
  //     narrows access).
  //   - text channel → its own explicit members ∪ its own creator.
  if (isForum(type)) {
    // Derived union = every post's own members ∪ every post's creator ∪ the
    // forum creator. Computed in a fixed number of queries (list posts, then one
    // `inArray` over their member rows) — NOT a per-post recursion (that was an
    // N+1: one round-trip per post).
    if (target[0]!.creatorId) set.add(target[0]!.creatorId);
    const posts = await db
      .select({ id: communityChannel.id, creatorId: communityChannel.creatorId })
      .from(communityChannel)
      .where(eq(communityChannel.parentChannelId, channelId));
    for (const p of posts) if (p.creatorId) set.add(p.creatorId);
    const postIds = posts.map((p) => p.id);
    if (postIds.length > 0) {
      const memberRows = await db
        .select({ userId: communityChannelMember.userId })
        .from(communityChannelMember)
        .where(inArray(communityChannelMember.channelId, postIds));
      for (const r of memberRows) set.add(r.userId);
    }
    return [...set];
  }

  // post → roster on self; thread/channel → climb to the anchor.
  const rosterAnchorId =
    isForumPost(type) ? target[0]!.id : (target[0]!.parentChannelId ?? target[0]!.id);
  const rosterCreatorId =
    isForumPost(type)
      ? target[0]!.creatorId
      : (await db
          .select({ creatorId: communityChannel.creatorId })
          .from(communityChannel)
          .where(eq(communityChannel.id, rosterAnchorId))
          .limit(1))[0]?.creatorId;

  for (const m of await listChannelMemberUserIds(db, rosterAnchorId)) set.add(m);
  if (rosterCreatorId) set.add(rosterCreatorId);
  return [...set];
}

/**
 * Top-level channels a viewer may SEE in a server (backs the server-detail
 * tree). Nested-membership model:
 *   - admin/owner → every top-level channel.
 *   - otherwise → all public/uncategorized channels, PLUS private-category text
 *     channels where the viewer is the creator OR has a member row, PLUS private
 *     FORUMS the viewer can see via membership in any of their posts (derived).
 * `parentChannelId IS NULL` (threads/posts excluded, mirroring
 * `listServerChannels`). The private-visibility set is computed by the shared
 * `resolveVisibleChannelIdSet` (which knows the forum-derived rule), then the
 * top-level rows are filtered by it in id space.
 */
export async function listServerChannelsForViewer(
  db: Database,
  serverId: string,
  userId: string
) {
  const base = and(
    eq(communityChannel.serverId, serverId),
    isNull(communityChannel.parentChannelId)
  );

  // No admin fast-path: admins have NO special visibility into private content
  // (they manage via admin-gated routes / the future Browse Channels surface).
  // Everyone — admins included — sees public channels + the private ones they
  // belong to.
  const [rows, visibleSet] = await Promise.all([
    db
      .select(CHANNEL_COLUMNS)
      .from(communityChannel)
      .where(base)
      .orderBy(asc(communityChannel.position)),
    resolveVisibleChannelIdSet(db, userId, { serverIds: [serverId] }),
  ]);
  return rows.filter((r) => visibleSet.has(r.id)).map(mapChannelRow);
}

// Shared visibility computation for the nested-membership model. Assembles the
// set of channel ids a viewer may see across the given servers, applying:
//   - top-level TEXT channel (private) → creator OR own member row.
//   - FORUM (private) → creator OR member of ANY child post (derived visibility;
//     forum membership is the union of its posts).
//   - THREAD → inherits parent channel visibility (WIDE — any channel member).
//   - FORUM_POST → if its forum is public, visible; if private, creator OR own
//     member row (NARROW — a private post is its own access unit).
// NO admin fast-path: admins/owner have NO special visibility into private
// content — they see exactly what a member sees (public ∪ private-they-belong-to).
// Done in JS because the thread-wide / post-narrow / forum-derived split is too
// branchy for one safe SQL predicate. Scoped by serverId up front (AGENTS.md).
//
// PERF (accepted trade-off): this reads all channel rows for the viewer's
// servers into memory and filters in JS, rather than filtering private
// visibility in SQL and returning only ids. Channel count per server is small
// (tens–hundreds — orders of magnitude below message volume), so this is fine
// in practice. If a server ever grows enough channels to matter, split into a
// cheap SQL id-query for public/uncategorized channels + a JS pass only for
// private units (forum-derived / post-narrow). Not done pre-emptively.
async function resolveVisibleChannelIdSet(
  db: Database,
  userId: string,
  opts: { serverIds: string[] }
): Promise<Set<string>> {
  const visible = new Set<string>();
  const { serverIds } = opts;
  if (serverIds.length === 0) return visible;

  const rows = await db
    .select({
      id: communityChannel.id,
      type: communityChannel.type,
      categoryId: communityChannel.categoryId,
      categoryPrivate: communityCategory.private,
      creatorId: communityChannel.creatorId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .where(inArray(communityChannel.serverId, serverIds));

  // The viewer's explicit channel/post member rows in these servers.
  const memberRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.userId, userId),
        inArray(communityChannel.serverId, serverIds)
      )
    );
  const memberChannelIds = new Set(memberRows.map((r) => r.channelId));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const postsByForum = new Map<string, typeof rows>();
  for (const r of rows) {
    if (isForumPost(r.type) && r.parentChannelId) {
      const list = postsByForum.get(r.parentChannelId) ?? [];
      list.push(r);
      postsByForum.set(r.parentChannelId, list);
    }
  }

  const isPrivate = (r: { categoryId: string | null; categoryPrivate: number | null }) =>
    r.categoryId != null && r.categoryPrivate === 1;

  // Pass 1 — top-level channels + forums.
  for (const r of rows) {
    if (r.parentChannelId != null) continue;
    if (!isPrivate(r) || r.creatorId === userId) {
      visible.add(r.id);
      continue;
    }
    if (isForum(r.type)) {
      const posts = postsByForum.get(r.id) ?? [];
      if (posts.some((p) => p.creatorId === userId || memberChannelIds.has(p.id))) {
        visible.add(r.id);
      }
    } else if (memberChannelIds.has(r.id)) {
      visible.add(r.id);
    }
  }

  // Pass 2 — children (threads inherit; forum posts are their own access unit).
  for (const r of rows) {
    if (r.parentChannelId == null) continue;
    const parent = byId.get(r.parentChannelId);
    if (!parent) continue;
    if (isForumPost(r.type)) {
      // Public forum → post public; private forum → creator or own member row.
      if (!isPrivate(parent) || r.creatorId === userId || memberChannelIds.has(r.id)) {
        visible.add(r.id);
      }
    } else if (visible.has(parent.id)) {
      // thread (or any other child) inherits the parent's visibility.
      visible.add(r.id);
    }
  }

  return visible;
}

/**
 * The set of channel ids (top-level AND child/thread/forum-post channels) a
 * viewer may see — backs read-path scoping for search / inbox / mark-all-read /
 * mentions. Type-aware per the nested-membership model (see
 * `resolveVisibleChannelIdSet`): threads inherit their parent's visibility;
 * private forum posts are their own access unit; a private forum is visible via
 * membership in any of its posts.
 */
export async function listVisibleChannelIds(
  db: Database,
  serverId: string,
  userId: string
): Promise<string[]> {
  const set = await resolveVisibleChannelIdSet(db, userId, { serverIds: [serverId] });
  return [...set];
}

/**
 * Cross-server sibling of `listVisibleChannelIds` — every channel id (top-level
 * AND child/thread/forum-post) a viewer may see across ALL of their servers, in
 * a handful of queries instead of an N+1 loop-per-server. Backs the inbox
 * consumers (unread + mentions + mark-all), which span every server the viewer
 * belongs to.
 *
 * A viewer sees public/uncategorized channels plus private units they created
 * or belong to (forum visibility derived from post membership). Admins get NO
 * special visibility — same rule as everyone.
 *
 * Bound-parameter ceiling (accepted risk): a viewer across many large servers
 * can produce a big id set; feeding it whole into a downstream `inArray`
 * approaches SQLite's bound-param limit. Same unchunked pattern as
 * `searchMessagesInServer`. Chunk only if it proves a real limit in practice.
 */
export async function listVisibleChannelIdsForUser(
  db: Database,
  userId: string
): Promise<string[]> {
  const memberships = await db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId));
  if (memberships.length === 0) return [];

  const set = await resolveVisibleChannelIdSet(db, userId, {
    serverIds: memberships.map((m) => m.serverId),
  });
  return [...set];
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

  // Privacy anchor vs roster anchor (nested-membership model):
  //   - forum post → privacy climbs to the forum (its category), but the ROSTER
  //     (member rows + creator) is the post's OWN id.
  //   - thread / top-level channel → privacy anchor == roster anchor.
  const isPost = isForumPost(channel.type);
  const rosterAnchorId = isPost ? channel.id : anchorId;
  const rosterCreatorId = isPost ? channel.creatorId : anchor.creatorId;

  let categoryPrivate = 0;
  if (anchor.categoryId) {
    const cat = await db
      .select({ private: communityCategory.private })
      .from(communityCategory)
      .where(eq(communityCategory.id, anchor.categoryId))
      .limit(1);
    categoryPrivate = cat[0]?.private ?? 0;
  }

  // A FORUM's access is derived from its posts (member of any child post);
  // everything else checks a member row on the roster anchor.
  const channelIsForum = isForum(channel.type);
  const memberFlag =
    categoryPrivate === 1
      ? channelIsForum
        ? await isMemberOfAnyChildPost(db, channel.id, userId)
        : await isChannelMember(db, rosterAnchorId, userId)
      : false;

  return {
    channel,
    anchor,
    role: member[0]!.role,
    isPrivate: categoryPrivate === 1,
    isChannelMember: memberFlag,
    // Roster-anchor creator (post's own creator for a post) — the access gate
    // must use this, NOT `anchor.creatorId`, which for a post is the forum's.
    isCreator: rosterCreatorId === userId,
  };
}
