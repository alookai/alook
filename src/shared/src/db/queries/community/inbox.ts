import { and, eq, isNotNull, isNull, inArray, ne, sql } from "drizzle-orm";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import {
  communityChannel,
  communityChannelMember,
  communityMessage,
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
  // null for a top-level channel; set for a thread / forum-post child. The
  // inbox route uses this to nest child unreads under their parent channel.
  parentChannelId: string | null;
}

/**
 * Two-branch unread predicate, shared by every reader that groups channels
 * by "unread since I last looked."
 *
 * - Archived / no lastMessageAt → not unread.
 * - Has read-state row → `hasUnreadBeyondSeq`: is there a message with
 *   `seq > lastReadSeq`? (ref/id read-model seq unification — this is the SAME
 *   seq ruler the agent inbox uses; `EXISTS(message.seq > COALESCE(lastReadSeq,0))`
 *   computed in SQL, passed in here). Strict `>` mirrors the "author's own send
 *   is not unread" invariant — `createMessage` advances the author's own
 *   `lastReadSeq` to that message's seq in the same batch. Replaces the old
 *   `lastMessageAt > lastReadAt` timestamp compare, which drifted from the
 *   agent side's seq compare.
 * - No read-state row → `lastMessageAt > joinedAt`. Users who joined a server
 *   AFTER historical messages were posted must not have those old messages
 *   flagged as unread. Kept on the TIMESTAMP: with no read-state row there's no
 *   `lastReadSeq` to compare and no bot/human cursor to drift between — the
 *   join baseline is orthogonal to the seq unification, so it stays as-is.
 *
 * Pure — exported for direct unit testing.
 */
export function isChannelUnread(row: {
  archived: boolean;
  lastMessageAt: string | null;
  hasReadState: boolean;
  hasUnreadBeyondSeq: boolean;
  joinedAt: string;
}): boolean {
  if (row.archived) return false;
  if (!row.lastMessageAt) return false;
  if (row.hasReadState) return row.hasUnreadBeyondSeq;
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
  // `visibleChannelIds` is an unbounded authorization scope (all channels the
  // viewer can see across every server). Chunk the `inArray` for D1's 100-param
  // limit; there's no order/limit/aggregate, so concat is loss-free (the unread
  // filtering runs in JS below).
  const rows = (
    await Promise.all(
      chunk(visibleChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            channelName: communityChannel.name,
            serverId: communityChannel.serverId,
            serverName: communityServer.name,
            type: communityChannel.type,
            parentChannelId: communityChannel.parentChannelId,
            lastMessageAt: communityChannel.lastMessageAt,
            // `hasReadState` distinguishes "read-state row exists" (→ seq
            // predicate) from "no row" (→ joinedAt timestamp branch). The
            // read-state row's own id is a cheap non-null marker under the
            // LEFT JOIN.
            hasReadState: sql<number>`(${communityReadState.id} IS NOT NULL)`,
            // The seq predicate (ref/id seq unification): is there any message
            // in this channel with seq beyond the viewer's read cursor? SAME
            // ruler as the agent inbox. COALESCE handles the no-row LEFT JOIN
            // (lastReadSeq NULL → 0), though the joinedAt branch takes over
            // there anyway per `isChannelUnread`.
            hasUnreadBeyondSeq: sql<number>`EXISTS (SELECT 1 FROM ${communityMessage} m WHERE m.channel_id = ${communityChannel.id} AND m.seq > COALESCE(${communityReadState.lastReadSeq}, 0))`,
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
              inArray(communityChannel.id, ids),
              isNotNull(communityChannel.lastMessageAt)
            )
          )
      )
    )
  ).flat();

  const unread = rows.filter((r) =>
    isChannelUnread({
      archived: r.archived,
      lastMessageAt: r.lastMessageAt,
      // SQL booleans arrive as 0/1 integers over D1.
      hasReadState: Boolean(r.hasReadState),
      hasUnreadBeyondSeq: Boolean(r.hasUnreadBeyondSeq),
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
}

/**
 * Mirrors `isChannelUnread` for DMs (ref/id read-model seq unification).
 *
 * - No `lastMessageAt` (empty conversation) → not unread.
 * - Has read-state row → `hasUnreadBeyondSeq` (EXISTS message with
 *   `seq > lastReadSeq`, computed in SQL — same seq ruler as channels + agent).
 *   `createMessage` advances the author's own `lastReadSeq` in the same batch,
 *   so this excludes the author's own send (same invariant as channels).
 * - No read-state row → unread as long as there IS a message. DMs have no
 *   "joinedAt" analog — the conversation only exists because one of the two
 *   participants opened it, and any message means the counterparty hasn't
 *   looked yet. (The `isNotNull(lastMessageAt)` WHERE guarantees a message.)
 */
export function isDmUnread(row: {
  lastMessageAt: string | null;
  hasReadState: boolean;
  hasUnreadBeyondSeq: boolean;
}): boolean {
  if (!row.lastMessageAt) return false;
  if (row.hasReadState) return row.hasUnreadBeyondSeq;
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
      hasReadState: sql<number>`(${communityReadState.id} IS NOT NULL)`,
      hasUnreadBeyondSeq: sql<number>`EXISTS (SELECT 1 FROM ${communityMessage} m WHERE m.channel_id = ${communityChannel.id} AND m.seq > COALESCE(${communityReadState.lastReadSeq}, 0))`,
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
      isDmUnread({
        lastMessageAt: r.lastMessageAt,
        hasReadState: Boolean(r.hasReadState),
        hasUnreadBeyondSeq: Boolean(r.hasUnreadBeyondSeq),
      })
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
    }));
}
