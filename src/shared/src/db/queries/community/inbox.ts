import { and, eq, isNotNull, isNull, inArray, ne } from "drizzle-orm";
import {
  communityChannel,
  communityChannelMember,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { listParticipatingThreadIds } from "./thread";
import { isThread, isForumPost } from "../../../utils/community-roles";

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  // Raw stored channel type (text | forum | thread | forum_post). Threaded
  // through to the inbox so it can render the same entity icon as the sidebar.
  type: string | null;
  lastMessageAt: string;
  lastReadAt: string | null;
  // null for a top-level channel; set for a thread / forum-post child. The
  // inbox route uses this to nest child unreads under their parent channel.
  parentChannelId: string | null;
}

/**
 * Two-branch unread predicate, shared by every reader that groups channels
 * by "unread since I last looked."
 *
 * - Archived / no lastMessageAt → not unread.
 * - Has read-state row → `lastMessageAt > lastReadAt` (normal path; strict
 *   `>` mirrors the "author's own send is not unread" invariant from
 *   `createMessage`, which writes lastMessageAt === lastReadAt in the same
 *   batch).
 * - No read-state row → `lastMessageAt > joinedAt`. Users who joined a
 *   server AFTER historical messages were posted must not have those old
 *   messages flagged as unread. Without this, every non-empty channel
 *   lights up on first join.
 *
 * Pure — exported for direct unit testing.
 */
export function isChannelUnread(row: {
  archived: boolean;
  lastMessageAt: string | null;
  lastReadAt: string | null;
  joinedAt: string;
}): boolean {
  if (row.archived) return false;
  if (!row.lastMessageAt) return false;
  if (row.lastReadAt) return row.lastMessageAt > row.lastReadAt;
  return row.lastMessageAt > row.joinedAt;
}

// ──────────────────────────────────────────────────────────────────────────────
// Unreads
// ──────────────────────────────────────────────────────────────────────────────

export async function listUnreadChannels(
  db: Database,
  userId: string,
  visibleChannelIds: string[]
): Promise<UnreadChannelRow[]> {
  // All channels — top-level AND child threads/forum-posts — the viewer may
  // see (the `visibleChannelIds` set, resolved once per inbox fetch via
  // `listVisibleChannelIdsForUser`), plus read state. Visibility is the id-set
  // `inArray`, NOT an inlined category `or()`: a child channel's own
  // `categoryId` is always NULL, so a flat `isNull(categoryId)` would treat
  // every thread as public and leak private threads. The id set is built by
  // parent-climbing, so a child is present only when its parent is visible.
  // Filtering to actually-unread happens in JS via `isChannelUnread`.
  if (visibleChannelIds.length === 0) return [];
  const rows = await db
    .select({
      channelId: communityChannel.id,
      channelName: communityChannel.name,
      serverId: communityChannel.serverId,
      serverName: communityServer.name,
      type: communityChannel.type,
      parentChannelId: communityChannel.parentChannelId,
      lastMessageAt: communityChannel.lastMessageAt,
      lastReadAt: communityReadState.lastReadAt,
      archived: communityChannel.archived,
      // Sidebar / inbox unread badges must ignore messages posted before
      // the viewer joined — otherwise every non-empty channel lights up
      // on first join. `joinedAt` is `notNull()` in the schema and the
      // INNER JOIN below scopes to real member rows, so it's always
      // present. See `isChannelUnread` above.
      joinedAt: communityServerMember.joinedAt,
    })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .innerJoin(communityServer, eq(communityServer.id, communityChannel.serverId))
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.channelId, communityChannel.id),
        eq(communityReadState.userId, userId)
      )
    )
    .where(
      and(
        eq(communityServerMember.userId, userId),
        inArray(communityChannel.id, visibleChannelIds),
        isNotNull(communityChannel.lastMessageAt)
      )
    );

  const unread = rows.filter((r) =>
    isChannelUnread({
      archived: r.archived,
      lastMessageAt: r.lastMessageAt,
      lastReadAt: r.lastReadAt,
      joinedAt: r.joinedAt,
    })
  );

  // Thread AND forum-post unreads are scoped to PARTICIPATION (notification
  // dimension): they surface in the inbox only for their participants, NOT for
  // every member who can merely read them. A public post is visible to the
  // whole server but only notifies its participants, so an un-joined post must
  // not flag as unread. Both store their notify set in the same participant
  // table (keyed by channel id), so one `listParticipatingThreadIds` covers
  // both. Top-level channels flow through the visibility path above unchanged.
  const notifyScopedIds = unread
    .filter((r) => isThread(r.type) || isForumPost(r.type))
    .map((r) => r.channelId);
  const participatingIds =
    notifyScopedIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, notifyScopedIds, userId))
      : new Set<string>();

  return unread
    .filter(
      (r) =>
        (!isThread(r.type) && !isForumPost(r.type)) ||
        participatingIds.has(r.channelId),
    )
    .map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      serverId: r.serverId,
      serverName: r.serverName,
      type: r.type,
      parentChannelId: r.parentChannelId,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
    }));
}

// ──────────────────────────────────────────────────────────────────────────────
// DM unreads
// ──────────────────────────────────────────────────────────────────────────────

export interface UnreadDmRow {
  channelId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserImage: string | null;
  lastMessageAt: string;
  lastReadAt: string | null;
}

/**
 * Mirrors `isChannelUnread` for DMs.
 *
 * - No `lastMessageAt` (empty conversation) → not unread.
 * - Has read-state row → strict `lastMessageAt > lastReadAt`. `createMessage`
 *   writes both timestamps equal in the same batch for the author, so this
 *   naturally excludes the author's own send (same invariant as channels).
 * - No read-state row → unread as long as there IS a message. DMs have no
 *   "joinedAt" analog — the conversation only exists because one of the two
 *   participants opened it, and any message means the counterparty hasn't
 *   looked yet.
 */
export function isDmUnread(row: {
  lastMessageAt: string | null;
  lastReadAt: string | null;
}): boolean {
  if (!row.lastMessageAt) return false;
  if (row.lastReadAt) return row.lastMessageAt > row.lastReadAt;
  return true;
}

export async function listUnreadDms(
  db: Database,
  userId: string
): Promise<UnreadDmRow[]> {
  // DMs are type='dm' channels; the viewer's DM channels are those they hold a
  // relation='access' member row on. First resolve those channel ids.
  const selfRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm")
      )
    );
  const dmChannelIds = selfRows.map((r) => r.channelId);
  if (dmChannelIds.length === 0) return [];

  // Join each DM channel to the PEER access member → user (name/avatar) and the
  // viewer's read-state row. Filtering happens in JS via `isDmUnread`.
  const rows = await db
    .select({
      channelId: communityChannel.id,
      lastMessageAt: communityChannel.lastMessageAt,
      lastReadAt: communityReadState.lastReadAt,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserImage: user.image,
    })
    .from(communityChannel)
    .innerJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.relation, "access"),
        ne(communityChannelMember.userId, userId)
      )
    )
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.channelId, communityChannel.id),
        eq(communityReadState.userId, userId)
      )
    )
    .where(
      and(
        inArray(communityChannel.id, dmChannelIds),
        isNotNull(communityChannel.lastMessageAt),
        isNull(user.deletedAt)
      )
    );

  const seen = new Set<string>();
  return rows
    .filter((r) =>
      isDmUnread({ lastMessageAt: r.lastMessageAt, lastReadAt: r.lastReadAt })
    )
    .filter((r) => {
      if (seen.has(r.channelId)) return false;
      seen.add(r.channelId);
      return true;
    })
    .map((r) => ({
      channelId: r.channelId,
      otherUserId: r.otherUserId,
      otherUserName: r.otherUserName,
      otherUserImage: r.otherUserImage,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
    }));
}
