import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  communityChannel,
  communityDmConversation,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  lastMessageAt: string;
  lastReadAt: string | null;
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
  userId: string
): Promise<UnreadChannelRow[]> {
  // All top-level channels in servers the user is a member of, plus read state.
  // Filtering happens in JS via `isChannelUnread` so we can keep one query.
  const rows = await db
    .select({
      channelId: communityChannel.id,
      channelName: communityChannel.name,
      serverId: communityChannel.serverId,
      serverName: communityServer.name,
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
        isNull(communityChannel.parentChannelId),
        isNotNull(communityChannel.lastMessageAt)
      )
    );

  return rows
    .filter((r) =>
      isChannelUnread({
        archived: r.archived,
        lastMessageAt: r.lastMessageAt,
        lastReadAt: r.lastReadAt,
        joinedAt: r.joinedAt,
      })
    )
    .map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      serverId: r.serverId,
      serverName: r.serverName,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
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
      lastReadAt: communityReadState.lastReadAt,
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
      isDmUnread({ lastMessageAt: r.lastMessageAt, lastReadAt: r.lastReadAt })
    )
    .map((r) => ({
      dmConversationId: r.dmConversationId,
      otherUserId: r.otherUserId,
      otherUserName: r.otherUserName,
      otherUserImage: r.otherUserImage,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
    }));
}
