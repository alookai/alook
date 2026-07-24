import { eq, and, asc, desc, isNull, max, inArray, count } from "drizzle-orm";
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

  // Unified model — the anchor (`parentChannelId ?? id`) is both the privacy and
  // roster anchor. A forum_post/thread climbs to its parent forum/channel for
  // BOTH the category-privacy flag and the roster (member rows + creator); a
  // top-level channel/forum is its own anchor. The single query below reads that
  // anchor and its creator.
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
    // ACCESS creator = the ANCHOR creator (the forum/parent-channel creator for a
    // post/thread). Feeds canSeePrivateChannel, so post access is pure inheritance
    // from the forum; post-manage rights are derived at the route from
    // channel.creatorId.
    const isCreator = anchor[0]?.creatorId === userId;
    // Membership checks a row on the anchor (own row for a forum/channel, the
    // parent forum/channel for a post/thread). Admins have NO content privilege
    // for private units — no role short-circuit here; an admin must be the
    // creator or an explicit member to see it.
    const isMember = isCreator ? false : await isChannelMember(db, anchorId, userId);
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
 * unit's creator. Unified model — a unit's roster is always its anchor's
 * (`parentChannelId ?? id`), so a forum_post/thread inherits its parent
 * forum/channel's roster. Only meaningful for a private anchor; callers guard on
 * `isChannelPrivate` first (fan-out short-circuits public channels to
 * `listMemberUserIds` and never calls this).
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
      creatorId: communityChannel.creatorId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  if (target.length === 0) return [];

  const set = new Set<string>();

  // Unified access model — a unit's roster is always its anchor's roster:
  //   - forum / text channel → its OWN explicit members ∪ its OWN creator.
  //   - forum_post / thread  → climbs `parentChannelId` to the anchor (the
  //     forum / parent channel) and uses THAT roster — a post inherits the
  //     forum's audience exactly like a thread inherits its channel's.
  // No derived union, no per-post roster: forum ≈ channel, forum_post ≈ thread.
  const rosterAnchorId = target[0]!.parentChannelId ?? target[0]!.id;
  const rosterCreatorId =
    rosterAnchorId === target[0]!.id
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
 * tree). Unified model:
 *   - all public/uncategorized channels/forums, PLUS
 *   - private-category channels/forums where the viewer is the creator OR has a
 *     member row (a forum owns its roster like a text channel; admins get NO
 *     implicit access).
 * `parentChannelId IS NULL` (threads/posts excluded, mirroring
 * `listServerChannels`). The private-visibility set is computed by the shared
 * `resolveVisibleChannelIdSet`, then the top-level rows are filtered by it in id
 * space.
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

  const isPrivate = (r: { categoryId: string | null; categoryPrivate: number | null }) =>
    r.categoryId != null && r.categoryPrivate === 1;

  // Pass 1 — top-level channels + forums. A private forum is visible via its OWN
  // member row (or creator), exactly like a private text channel — no derived
  // per-post visibility.
  for (const r of rows) {
    if (r.parentChannelId != null) continue;
    if (!isPrivate(r) || r.creatorId === userId || memberChannelIds.has(r.id)) {
      visible.add(r.id);
    }
  }

  // Pass 2 — children. Both forum posts AND threads INHERIT their parent's
  // visibility (a forum member sees every post; a channel member sees every
  // thread). No per-post access unit.
  for (const r of rows) {
    if (r.parentChannelId == null) continue;
    const parent = byId.get(r.parentChannelId);
    if (!parent) continue;
    if (visible.has(parent.id)) {
      visible.add(r.id);
    }
  }

  return visible;
}

/**
 * The set of channel ids (top-level AND child/thread/forum-post channels) a
 * viewer may see — backs read-path scoping for search / inbox / mark-all-read /
 * mentions. Unified model (see `resolveVisibleChannelIdSet`): forum posts AND
 * threads inherit their parent's visibility; a private forum/channel is visible
 * via the viewer's own member row (or creator).
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
 * or belong to (a forum's visibility comes from its own member row, like a text
 * channel; posts/threads inherit their parent). Admins get NO special
 * visibility — same rule as everyone.
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

  // Unified model — privacy anchor == roster anchor == `parentChannelId ?? id`.
  // A forum_post/thread climbs to its parent (forum/channel) for BOTH the
  // category-privacy flag and the roster; a forum/top-level channel is its own
  // anchor. So post access is pure inheritance from the forum, exactly like a
  // thread inherits its channel — no per-post roster, no forum-derived union.
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
    categoryPrivate === 1 ? await isChannelMember(db, anchorId, userId) : false;

  return {
    channel,
    anchor,
    role: member[0]!.role,
    isPrivate: categoryPrivate === 1,
    isChannelMember: memberFlag,
    // ACCESS creator = the ANCHOR creator (the forum/parent-channel creator for a
    // post/thread). Feeds canSeePrivateChannel/canManage. Post-manage rights
    // (edit tags / delete) are derived at the route from `channel.creatorId`, NOT
    // this flag.
    isCreator: anchor.creatorId === userId,
  };
}
