import { aliasedTable, and, count, desc, eq, exists, gt, isNotNull, isNull, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { chunk } from "../_chunk";
import { jsonTextSet } from "../_json-set";
import {
  communityChannel,
  communityChannelMember,
  communityMessage,
  communityQuestionTodo,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { listParticipatingThreadIds } from "./thread";

import { DECISION_CARD_MESSAGE_TYPE } from "../../../community-decision-card";
import { reachIsParticipantSet } from "../../../utils/community-roles";
import { hasUnreadAttentionSql, notificationEligibleSql } from "./notification-eligibility";
import { dmPeerReadableSql } from "./dm";
import {
  accountReadStateRevisionBuilder,
  advanceReadStateRevisionWhenBuilder,
} from "./read-state";

const ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE = 80;

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;

  type: string | null;
  lastMessageAt: string;

  parentChannelId: string | null;
}

export interface EligibleUnreadChannelRow extends UnreadChannelRow {
  mentionCount: number;
  unreadCount: number;
  /** Highest unread message sequence represented by this row. */
  lastUnreadSeq: number;
  /** Highest unread attention-bearing message sequence, when present. */
  lastAttentionSeq: number | null;
}

export interface UnreadForumOpenerRow {
  forumChannelId: string;
  openerMessageId: string;
  childChannelId: string;
  title: string;
  createdAt: string;

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
            lastUnreadSeq: sql<number>`MAX(${communityMessage.seq})`.mapWith(Number),
            unreadCount: count(),
            lastAttentionSeq: sql<number | null>`MAX(CASE WHEN ${hasUnreadAttentionSql(userId, communityMessage.id)} THEN ${communityMessage.seq} ELSE NULL END)`,
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
              ne(communityMessage.authorId, userId),
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

  const forumIds = jsonTextSet(db, [...new Set(forumParentIds)]).as("forum_inbox_ids");
  const childChannel = aliasedTable(communityChannel, "forum_inbox_child");
  const rows = await db
    .select({
      forumChannelId: communityMessage.channelId,
      openerMessageId: communityMessage.id,
      openerContent: communityMessage.content,
      openerSeq: communityMessage.seq,
      childChannelId: childChannel.id,
      childName: childChannel.name,
      createdAt: communityMessage.createdAt,
    })
    .from(forumIds)
    .crossJoin(communityChannel)
    .crossJoin(communityMessage)
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
        eq(communityChannel.id, forumIds.value),
        eq(communityMessage.channelId, communityChannel.id),
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
    );

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
  const rows = await db
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
        inArray(childChannel.id, jsonTextSet(db, childIds)),
        eq(childChannel.type, "thread"),
        eq(childChannel.archived, 0),
        eq(parentChannel.archived, 0),
        isNull(parentChannel.parentChannelId)
      )
    );

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

export interface UnreadDmRow {
  channelId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserDiscriminator: string;
  otherUserImage: string | null;
  otherUserAvatarVersion: number;
  lastMessageAt: string;
}

export interface EligibleUnreadDmRow extends UnreadDmRow {
  lastUnreadSeq: number;
  unreadCount: number;
}

export async function listReadableDmChannelIds(
  db: Database,
  userId: string
): Promise<string[]> {
  const selfRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm"),
        dmPeerReadableSql(db, userId, communityChannel.id)
      )
    );
  return selfRows.map((row) => row.channelId);
}

export async function listReadableDmSummariesByChannelIds(
  db: Database,
  userId: string,
  channelIds: string[],
): Promise<UnreadDmRow[]> {
  const uniqueIds = [...new Set(channelIds)];
  if (uniqueIds.length === 0) return [];
  const rows = (
    await Promise.all(
      chunk(uniqueIds, ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            otherUserId: user.id,
            otherUserName: user.name,
            otherUserDiscriminator: user.discriminator,
            otherUserImage: user.image,
            otherUserAvatarVersion: user.avatarVersion,
            lastMessageAt: sql<string>`COALESCE(${communityChannel.lastMessageAt}, ${communityChannel.createdAt})`,
          })
          .from(communityChannel)
          .innerJoin(
            communityChannelMember,
            and(
              eq(communityChannelMember.channelId, communityChannel.id),
              eq(communityChannelMember.relation, "access"),
              ne(communityChannelMember.userId, userId),
            ),
          )
          .innerJoin(user, eq(user.id, communityChannelMember.userId))
          .where(
            and(
              inArray(communityChannel.id, ids),
              eq(communityChannel.type, "dm"),
              isNull(user.deletedAt),
            ),
          ),
      ),
    )
  ).flat();

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.channelId)) return false;
    seen.add(row.channelId);
    return true;
  });
}

export async function listEligibleUnreadDms(
  db: Database,
  userId: string
): Promise<EligibleUnreadDmRow[]> {
  const dmChannelIds = await listReadableDmChannelIds(db, userId);
  if (dmChannelIds.length === 0) return [];

  const rows = (
    await Promise.all(
      chunk(dmChannelIds, ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            otherUserId: user.id,
            otherUserName: user.name,
            otherUserDiscriminator: user.discriminator,
            otherUserImage: user.image,
            otherUserAvatarVersion: user.avatarVersion,
            lastMessageAt: sql<string>`MAX(${communityMessage.createdAt})`,
            lastUnreadSeq: sql<number>`MAX(${communityMessage.seq})`.mapWith(Number),
            unreadCount: count(),
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
              ne(communityMessage.authorId, userId),
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

export interface PendingQuestionRow {
  id: string;
  channelId: string;
  seq: number;
  content: string;
  embeds: string | null;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorDiscriminator: string;
  authorImage: string | null;
  authorAvatarVersion: number;
}

/**
 * Pending unanswered, undismissed `question` (Decision Card) todos assigned to
 * the viewer inside their authorized server channels/threads and readable DMs.
 * Reading a channel does NOT clear a pending question: it remains pending
 * until the viewer replies (`idx_community_message_channel_reply_author`) or
 * explicitly dismisses it (`community_question_todo.dismissed_at`).
 *
 * Driven from `idx_community_question_todo_user_active` so D1 only touches the
 * viewer's own non-dismissed assignments in newest-first order and stops at
 * `opts.limit`, never pulling other users' question cards into Worker memory.
 */
export async function listPendingQuestionMessages(
  db: Database,
  userId: string,
  serverChannelIds: string[],
  dmChannelIds: string[],
  opts?: { limit?: number },
): Promise<PendingQuestionRow[]> {
  const allChannelIds = [...new Set([...serverChannelIds, ...dmChannelIds])];
  if (allChannelIds.length === 0) return [];
  const perChunkLimit = opts?.limit !== undefined ? Math.max(1, opts.limit) : undefined;

  const replyMessage = aliasedTable(communityMessage, "question_viewer_reply");
  const notAnsweredByViewer = notExists(
    db
      .select({ one: sql<number>`1` })
      .from(replyMessage)
      .where(
        and(
          eq(replyMessage.channelId, communityQuestionTodo.channelId),
          eq(replyMessage.replyToId, communityQuestionTodo.messageId),
          eq(replyMessage.authorId, userId),
        ),
      ),
  );

  const selection = {
    id: communityMessage.id,
    channelId: communityMessage.channelId,
    seq: communityMessage.seq,
    content: communityMessage.content,
    embeds: communityMessage.embeds,
    createdAt: communityMessage.createdAt,
    authorId: user.id,
    authorName: user.name,
    authorDiscriminator: user.discriminator,
    authorImage: user.image,
    authorAvatarVersion: user.avatarVersion,
  };

  const rows = (
    await Promise.all(
      chunk(allChannelIds, ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE).map((ids) => {
        const query = db
          .select(selection)
          .from(communityQuestionTodo)
          .innerJoin(
            communityMessage,
            eq(communityMessage.id, communityQuestionTodo.messageId),
          )
          .innerJoin(
            communityChannel,
            eq(communityChannel.id, communityQuestionTodo.channelId),
          )
          .innerJoin(user, eq(user.id, communityMessage.authorId))
          .where(
            and(
              eq(communityQuestionTodo.userId, userId),
              isNull(communityQuestionTodo.dismissedAt),
              inArray(communityQuestionTodo.channelId, ids),
              eq(communityMessage.type, DECISION_CARD_MESSAGE_TYPE),
              ne(communityMessage.authorId, userId),
              eq(communityChannel.archived, 0),
              notAnsweredByViewer,
            ),
          )
          .orderBy(
            desc(communityQuestionTodo.createdAt),
            desc(communityQuestionTodo.messageId),
          );
        return perChunkLimit !== undefined ? query.limit(perChunkLimit) : query;
      }),
    )
  ).flat();

  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  unique.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
  return perChunkLimit !== undefined ? unique.slice(0, perChunkLimit) : unique;
}

export async function dismissQuestionTodoWithRevision(
  db: Database,
  userId: string,
  messageId: string,
) {
  const hasActiveTodo = exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityQuestionTodo)
      .where(
        and(
          eq(communityQuestionTodo.userId, userId),
          eq(communityQuestionTodo.messageId, messageId),
          isNull(communityQuestionTodo.dismissedAt),
        ),
      ),
  );
  const now = new Date().toISOString();
  const dismissTodo = db
    .update(communityQuestionTodo)
    .set({ dismissedAt: now })
    .where(
      and(
        eq(communityQuestionTodo.userId, userId),
        eq(communityQuestionTodo.messageId, messageId),
        isNull(communityQuestionTodo.dismissedAt),
      ),
    );
  const results = (await db.batch([
    advanceReadStateRevisionWhenBuilder(db, userId, hasActiveTodo),
    dismissTodo,
    accountReadStateRevisionBuilder(db, userId),
  ] as any)) as unknown[];
  return {
    changed: (results[0] as Array<{ revision: number }>).length > 0,
    revision: (results[2] as Array<{ revision: number }>)[0]?.revision ?? 0,
  };
}
