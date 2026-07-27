import { and, eq, isNotNull, isNull, inArray, or } from "drizzle-orm";
import {
  communityChannel,
  communityDmConversation,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { listParticipatingThreadIds } from "./thread";
import { isThread, isPost } from "../../../utils/community-roles";

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  // Raw stored channel type (text | forum | thread | post). Threaded
  // through to the inbox so it can render the same entity icon as the sidebar.
  type: string | null;
  lastMessageAt: string;
  lastReadAt: string | null;
  // Newest seq in the scope + the viewer's read cursor. A bot consumer reads
  // these to know where to page from (`?afterSeq=lastReadSeq`); the human UI
  // ignores them and sorts by lastMessageAt.
  lastMessageSeq: number;
  lastReadSeq: number | null;
  // null for a top-level channel; set for a thread / forum-post child. The
  // inbox route uses this to nest child unreads under their parent channel.
  parentChannelId: string | null;
}

/**
 * Two-branch unread predicate, shared by every reader that groups channels by
 * "unread since I last looked."
 *
 * - Archived / no messages → not unread.
 * - Has read-state row → `lastMessageSeq > lastReadSeq` (the seq path — a
 *   single-column compare, the seq twin of the old `lastMessageAt >
 *   lastReadAt`; strict `>` excludes the author's own send, which seeds
 *   lastReadSeq === the new seq in the same batch). Opening a channel writes
 *   this row, so the `↓N` count derived from `lastReadSeq` stays correct.
 * - No read-state row → `lastMessageAt > joinedAt`. A member who joined AFTER
 *   historical messages were posted must not see them flagged unread. seq has
 *   no cross-scope "join baseline" (it's per-channel), so the join-time
 *   timestamp fallback is retained for the never-opened case.
 *
 * Pure — exported for direct unit testing.
 */
export function isChannelUnread(row: {
  archived: boolean;
  lastMessageAt: string | null;
  lastMessageSeq: number;
  lastReadAt: string | null;
  lastReadSeq: number | null;
  joinedAt: string;
}): boolean {
  if (row.archived) return false;
  if (row.lastReadAt) return row.lastMessageSeq > (row.lastReadSeq ?? 0);
  if (!row.lastMessageAt) return false;
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
      lastMessageSeq: communityChannel.lastMessageSeq,
      lastReadAt: communityReadState.lastReadAt,
      lastReadSeq: communityReadState.lastReadSeq,
      archived: communityChannel.archived,
      // Retained for the no-read-state-row branch of `isChannelUnread`: a
      // member who joined after old messages were posted must not see them
      // flagged. INNER JOIN below scopes to real member rows, so notNull.
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
      lastMessageSeq: r.lastMessageSeq,
      lastReadAt: r.lastReadAt,
      lastReadSeq: r.lastReadSeq,
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
    .filter((r) => isThread(r.type) || isPost(r.type))
    .map((r) => r.channelId);
  const participatingIds =
    notifyScopedIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, notifyScopedIds, userId))
      : new Set<string>();

  return unread
    .filter(
      (r) =>
        (!isThread(r.type) && !isPost(r.type)) ||
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
      lastMessageSeq: r.lastMessageSeq,
      lastReadSeq: r.lastReadSeq,
    }));
}

// ──────────────────────────────────────────────────────────────────────────────
// DM unreads
// ──────────────────────────────────────────────────────────────────────────────

export interface UnreadDmRow {
  dmConversationId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserImage: string | null;
  lastMessageAt: string;
  lastReadAt: string | null;
  // Seq cursor pair, same purpose as on UnreadChannelRow — a bot pages from
  // `?afterSeq=lastReadSeq`; the human UI ignores these.
  lastMessageSeq: number;
  lastReadSeq: number | null;
}

/**
 * Mirrors `isChannelUnread` for DMs.
 *
 * - Has read-state row → `lastMessageSeq > lastReadSeq` (seq path; strict `>`
 *   excludes the author's own send, seeded to the new seq in the same batch).
 * - No read-state row → unread as long as there IS a message. DMs have no
 *   "joinedAt" analog — the conversation exists only because a participant
 *   opened it, so any message means the counterparty hasn't looked yet.
 */
export function isDmUnread(row: {
  lastMessageAt: string | null;
  lastMessageSeq: number;
  lastReadAt: string | null;
  lastReadSeq: number | null;
}): boolean {
  if (row.lastReadAt) return row.lastMessageSeq > (row.lastReadSeq ?? 0);
  return !!row.lastMessageAt;
}

export async function listUnreadDms(
  db: Database,
  userId: string
): Promise<UnreadDmRow[]> {
  // Every DM the viewer participates in (user1 OR user2), joined to the
  // counterpart user row (name/avatar for rendering) and the viewer's DM
  // read-state row. Filtering happens in JS via `isDmUnread` — the shape
  // mirrors `listUnreadChannels`.
  const rows = await db
    .select({
      dmConversationId: communityDmConversation.id,
      user1Id: communityDmConversation.user1Id,
      user2Id: communityDmConversation.user2Id,
      lastMessageAt: communityDmConversation.lastMessageAt,
      lastMessageSeq: communityDmConversation.lastMessageSeq,
      lastReadAt: communityReadState.lastReadAt,
      lastReadSeq: communityReadState.lastReadSeq,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserImage: user.image,
    })
    .from(communityDmConversation)
    .innerJoin(
      user,
      // The counterpart is whichever side isn't the viewer. `or(eq(user.id,
      // user1Id), eq(user.id, user2Id))` alone would double-join; instead we
      // pick the opposite side per row via two eq'd cases that only one of
      // which is true for a given viewer.
      or(
        and(
          eq(communityDmConversation.user1Id, userId),
          eq(user.id, communityDmConversation.user2Id)
        ),
        and(
          eq(communityDmConversation.user2Id, userId),
          eq(user.id, communityDmConversation.user1Id)
        )
      )
    )
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.dmConversationId, communityDmConversation.id),
        eq(communityReadState.userId, userId)
      )
    )
    .where(
      and(
        or(
          eq(communityDmConversation.user1Id, userId),
          eq(communityDmConversation.user2Id, userId)
        ),
        isNotNull(communityDmConversation.lastMessageAt),
        isNull(user.deletedAt)
      )
    );

  return rows
    .filter((r) =>
      isDmUnread({
        lastMessageAt: r.lastMessageAt,
        lastMessageSeq: r.lastMessageSeq,
        lastReadAt: r.lastReadAt,
        lastReadSeq: r.lastReadSeq,
      })
    )
    .map((r) => ({
      dmConversationId: r.dmConversationId,
      otherUserId: r.otherUserId,
      otherUserName: r.otherUserName,
      otherUserImage: r.otherUserImage,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
      lastMessageSeq: r.lastMessageSeq,
      lastReadSeq: r.lastReadSeq,
    }));
}
