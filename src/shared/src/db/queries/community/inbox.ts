import { aliasedTable, and, eq, gt, isNotNull, isNull, inArray, ne, or, sql } from "drizzle-orm";
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
import { listVisibleChannelIdsForUser } from "./channel";
import { reachIsParticipantSet } from "../../../utils/community-roles";
import { hasUnreadAttentionSql, notificationEligibleSql } from "./notification-eligibility";

const ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE = 80;

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  // Raw stored channel type (text | forum | thread). Threaded through to the
  // inbox so it can render the same entity icon as the sidebar.
  type: string | null;
  lastMessageAt: string;
  // null for a top-level channel; set for a child thread. The
  // inbox route uses this to nest child unreads under their parent channel.
  parentChannelId: string | null;
}

export interface EligibleUnreadChannelRow extends UnreadChannelRow {
  mentionCount: number;
}

export interface UnreadForumOpenerRow {
  forumChannelId: string;
  openerMessageId: string;
  childChannelId: string;
  title: string;
  createdAt: string;
  // Kept in the read-model row so callers can preserve the query's stable
  // createdAt → seq → id order through their own merge/cap pass.
  openerSeq: number;
}

export interface ThreadOpenerRow {
  parentChannelId: string;
  parentType: string | null;
  openerMessageId: string;
  childChannelId: string;
  title: string;
  createdAt: string;
  openerSeq: number;
  openerUnread: boolean;
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
  // All channels — top-level AND child threads — the viewer may
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

  // Child-thread unreads are scoped to PARTICIPATION (notification
  // dimension): they surface in the inbox only for their participants, NOT for
  // every member who can merely read them. A public post is visible to the
  // whole server but only notifies its participants, so an un-joined post must
  // not flag as unread. Both store their notify set in the same participant
  // table (keyed by channel id), so one `listParticipatingThreadIds` covers
  // both. Top-level channels flow through the visibility path above unchanged.
  const notifyScopedIds = unread
    .filter((r) => reachIsParticipantSet(r.type))
    .map((r) => r.channelId);
  const participatingIds =
    notifyScopedIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, notifyScopedIds, userId))
      : new Set<string>();

  return unread
    .filter(
      (r) =>
        !reachIsParticipantSet(r.type) ||
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

/**
 * Web Inbox channel summary over the same attention-eligible unread set used
 * by bot pull/snapshot and wake delivery. Policy filtering happens before the
 * aggregate, so its timestamp and mention count describe the eligible subset
 * rather than raw channel backlog.
 */
export async function listEligibleUnreadChannels(
  db: Database,
  userId: string,
  visibleChannelIds: string[]
): Promise<EligibleUnreadChannelRow[]> {
  if (visibleChannelIds.length === 0) return [];

  const rows = (
    await Promise.all(
      chunk(visibleChannelIds, ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            channelName: communityChannel.name,
            serverId: communityChannel.serverId,
            serverName: communityServer.name,
            type: communityChannel.type,
            parentChannelId: communityChannel.parentChannelId,
            lastMessageAt: sql<string>`MAX(${communityMessage.createdAt})`,
            mentionCount: sql<number>`SUM(CASE WHEN ${hasUnreadAttentionSql(userId, communityMessage.id)} THEN 1 ELSE 0 END)`,
          })
          .from(communityMessage)
          .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
          .innerJoin(communityServer, eq(communityServer.id, communityChannel.serverId))
          .innerJoin(
            communityServerMember,
            and(
              eq(communityServerMember.serverId, communityChannel.serverId),
              eq(communityServerMember.userId, userId)
            )
          )
          .leftJoin(
            communityReadState,
            and(
              eq(communityReadState.channelId, communityChannel.id),
              eq(communityReadState.userId, userId)
            )
          )
          .where(
            and(
              inArray(communityChannel.id, ids),
              eq(communityChannel.archived, 0),
              or(
                and(
                  isNotNull(communityReadState.id),
                  gt(
                    communityMessage.seq,
                    sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`
                  )
                ),
                and(
                  isNull(communityReadState.id),
                  gt(communityMessage.createdAt, communityServerMember.joinedAt)
                )
              ),
              notificationEligibleSql(
                userId,
                {
                  id: communityChannel.id,
                  serverId: communityChannel.serverId,
                  parentChannelId: communityChannel.parentChannelId,
                },
                {
                  id: communityMessage.id,
                }
              )
            )
          )
          .groupBy(communityChannel.id)
      )
    )
  ).flat();

  const notifyScopedIds = rows
    .filter((row) => reachIsParticipantSet(row.type))
    .map((row) => row.channelId);
  const participatingIds = notifyScopedIds.length > 0
    ? new Set(await listParticipatingThreadIds(db, notifyScopedIds, userId))
    : new Set<string>();

  return rows.filter(
    (row) => !reachIsParticipantSet(row.type) || participatingIds.has(row.channelId)
  );
}

export async function listEligibleUnreadServerIds(
  db: Database,
  userId: string
): Promise<string[]> {
  const visibleChannelIds = await listVisibleChannelIdsForUser(db, userId);
  const rows = await listEligibleUnreadChannels(db, userId, visibleChannelIds);
  return [...new Set(rows.map((row) => row.serverId))];
}

/**
 * Project every unread forum opener under an already-authorized parent scope.
 *
 * `forumParentIds` is intentionally supplied by the caller after visibility
 * and mute filtering. This query never discovers forums globally: it only
 * expands messages inside that bounded id set and joins each opener to the
 * child channel rooted on it.
 */
export async function listUnreadForumOpeners(
  db: Database,
  userId: string,
  forumParentIds: string[]
): Promise<UnreadForumOpenerRow[]> {
  if (forumParentIds.length === 0) return [];

  const childChannel = aliasedTable(communityChannel, "forum_inbox_child");
  const rows = (
    await Promise.all(
      chunk(forumParentIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            forumChannelId: communityMessage.channelId,
            openerMessageId: communityMessage.id,
            openerContent: communityMessage.content,
            openerSeq: communityMessage.seq,
            childChannelId: childChannel.id,
            childName: childChannel.name,
            createdAt: communityMessage.createdAt,
          })
          .from(communityMessage)
          .innerJoin(
            communityChannel,
            eq(communityChannel.id, communityMessage.channelId)
          )
          .innerJoin(
            childChannel,
            and(
              eq(childChannel.parentChannelId, communityChannel.id),
              eq(childChannel.parentMessageId, communityMessage.id)
            )
          )
          .innerJoin(
            communityServerMember,
            and(
              eq(communityServerMember.serverId, communityChannel.serverId),
              eq(communityServerMember.userId, userId)
            )
          )
          .leftJoin(
            communityReadState,
            and(
              eq(communityReadState.channelId, communityChannel.id),
              eq(communityReadState.userId, userId)
            )
          )
          .where(
            and(
              inArray(communityChannel.id, ids),
              isNull(communityChannel.parentChannelId),
              eq(communityChannel.type, "forum"),
              eq(communityChannel.archived, 0),
              eq(childChannel.archived, 0),
              or(
                and(
                  isNotNull(communityReadState.id),
                  gt(
                    communityMessage.seq,
                    sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`
                  )
                ),
                and(
                  isNull(communityReadState.id),
                  gt(communityMessage.createdAt, communityServerMember.joinedAt)
                )
              ),
              notificationEligibleSql(
                userId,
                {
                  id: communityChannel.id,
                  serverId: communityChannel.serverId,
                  parentChannelId: communityChannel.parentChannelId,
                },
                {
                  id: communityMessage.id,
                }
              )
            )
          )
      )
    )
  ).flat();

  // D1 chunks are independent statements. Sort only after concatenation so a
  // chunk boundary can never change the rows that survive the Inbox cap.
  rows.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.openerSeq - a.openerSeq ||
      b.openerMessageId.localeCompare(a.openerMessageId)
  );

  return rows.map((row) => ({
    forumChannelId: row.forumChannelId,
    openerMessageId: row.openerMessageId,
    childChannelId: row.childChannelId,
    // The opener is the forum title source of truth. Child names are derived
    // and truncated, so they are only an anomaly fallback for blank content.
    title:
      row.openerContent.trim().length > 0
        ? row.openerContent
        : row.childName?.trim() || "Thread",
    createdAt: row.createdAt,
    openerSeq: row.openerSeq,
  }));
}

/**
 * Resolve canonical parent-opener metadata for child rows that already passed
 * Inbox visibility, participation, notification, and mute filtering. This
 * lookup enriches those rows only; it never discovers additional children.
 */
export async function listThreadOpenersByChildIds(
  db: Database,
  userId: string,
  childIds: string[]
): Promise<ThreadOpenerRow[]> {
  if (childIds.length === 0) return [];

  const childChannel = aliasedTable(communityChannel, "thread_inbox_child_lookup");
  const parentChannel = aliasedTable(communityChannel, "thread_inbox_parent_lookup");
  const rows = (
    await Promise.all(
      chunk(childIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            parentChannelId: parentChannel.id,
            parentType: parentChannel.type,
            openerMessageId: communityMessage.id,
            openerContent: communityMessage.content,
            openerSeq: communityMessage.seq,
            childChannelId: childChannel.id,
            childName: childChannel.name,
            createdAt: communityMessage.createdAt,
            openerUnread: sql<number>`(
              (
                (${communityReadState.id} IS NOT NULL AND ${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0))
                OR
                (${communityReadState.id} IS NULL AND ${communityMessage.createdAt} > ${communityServerMember.joinedAt})
              )
              AND ${notificationEligibleSql(
                userId,
                {
                  id: parentChannel.id,
                  serverId: parentChannel.serverId,
                  parentChannelId: parentChannel.parentChannelId,
                },
                { id: communityMessage.id }
              )}
            )`,
          })
          .from(childChannel)
          .innerJoin(
            parentChannel,
            eq(parentChannel.id, childChannel.parentChannelId)
          )
          .innerJoin(
            communityMessage,
            and(
              eq(communityMessage.id, childChannel.parentMessageId),
              eq(communityMessage.channelId, parentChannel.id)
            )
          )
          .innerJoin(
            communityServerMember,
            and(
              eq(communityServerMember.serverId, parentChannel.serverId),
              eq(communityServerMember.userId, userId)
            )
          )
          .leftJoin(
            communityReadState,
            and(
              eq(communityReadState.channelId, parentChannel.id),
              eq(communityReadState.userId, userId)
            )
          )
          .where(
            and(
              inArray(childChannel.id, ids),
              eq(childChannel.type, "thread"),
              eq(childChannel.archived, 0),
              eq(parentChannel.archived, 0),
              isNull(parentChannel.parentChannelId)
            )
          )
      )
    )
  ).flat();

  rows.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.openerSeq - a.openerSeq ||
      b.openerMessageId.localeCompare(a.openerMessageId)
  );

  return rows.map((row) => ({
    parentChannelId: row.parentChannelId,
    parentType: row.parentType,
    openerMessageId: row.openerMessageId,
    childChannelId: row.childChannelId,
    title:
      row.openerContent.trim().length > 0
        ? row.openerContent
        : row.childName?.trim() || "Thread",
    createdAt: row.createdAt,
    openerSeq: row.openerSeq,
    openerUnread: Boolean(row.openerUnread),
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// DM unreads
// ──────────────────────────────────────────────────────────────────────────────

export interface UnreadDmRow {
  channelId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserDiscriminator: string;
  otherUserImage: string | null;
  otherUserAvatarVersion: number;
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
      otherUserDiscriminator: user.discriminator,
      otherUserImage: user.image,
      otherUserAvatarVersion: user.avatarVersion,
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
      otherUserDiscriminator: r.otherUserDiscriminator,
      otherUserImage: r.otherUserImage,
      otherUserAvatarVersion: r.otherUserAvatarVersion,
      lastMessageAt: r.lastMessageAt!,
    }));
}

/** DM counterpart of `listEligibleUnreadChannels`. */
export async function listEligibleUnreadDms(
  db: Database,
  userId: string
): Promise<UnreadDmRow[]> {
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
  const dmChannelIds = selfRows.map((row) => row.channelId);
  if (dmChannelIds.length === 0) return [];

  const rows = (
    await Promise.all(
      chunk(dmChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            otherUserId: user.id,
            otherUserName: user.name,
            otherUserDiscriminator: user.discriminator,
            otherUserImage: user.image,
            otherUserAvatarVersion: user.avatarVersion,
            lastMessageAt: sql<string>`MAX(${communityMessage.createdAt})`,
          })
          .from(communityMessage)
          .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
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
              inArray(communityChannel.id, ids),
              isNull(user.deletedAt),
              gt(
                communityMessage.seq,
                sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`
              ),
              notificationEligibleSql(
                userId,
                {
                  id: communityChannel.id,
                  serverId: communityChannel.serverId,
                  parentChannelId: communityChannel.parentChannelId,
                },
                {
                  id: communityMessage.id,
                }
              )
            )
          )
          .groupBy(communityChannel.id, user.id)
      )
    )
  ).flat();

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.channelId)) return false;
    seen.add(row.channelId);
    return true;
  });
}
