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
import {
  hasAttentionSql,
  hasUnreadAttentionSql,
  loadUserNotificationSettingLookup,
  resolveEffectiveNotificationLevel,
  type NotificationSettingLookup,
} from "./notification-eligibility";
import { dmPeerReadableSql } from "./dm";
import {
  accountReadStateRevisionBuilder,
  advanceReadStateRevisionWhenBuilder,
} from "./read-state";

const ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE = 80;
export const DEFAULT_UNREAD_FORUM_OPENERS_LIMIT = 100;

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
  visibleChannelIds: string[],
  opts?: { settings?: NotificationSettingLookup }
): Promise<EligibleUnreadChannelRow[]> {
  const uniqueVisibleIds = [...new Set(visibleChannelIds)];
  if (uniqueVisibleIds.length === 0) return [];

  const [channelMeta, settings] = await Promise.all([
    db
      .select({
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
        archived: communityChannel.archived,
      })
      .from(communityChannel)
      .where(
        and(
          inArray(communityChannel.id, jsonTextSet(db, uniqueVisibleIds)),
          eq(communityChannel.archived, 0),
        ),
      ),
    opts?.settings ? Promise.resolve(opts.settings) : loadUserNotificationSettingLookup(db, userId),
  ]);
  if (channelMeta.length === 0) return [];

  const notifyScopedIds = channelMeta
    .filter((ch) => reachIsParticipantSet(ch.type))
    .map((ch) => ch.id);
  const participatingIds = notifyScopedIds.length > 0
    ? new Set(await listParticipatingThreadIds(db, notifyScopedIds, userId))
    : new Set<string>();

  const allLevelIds: string[] = [];
  const mentionsLevelIds: string[] = [];
  for (const ch of channelMeta) {
    if (reachIsParticipantSet(ch.type) && !participatingIds.has(ch.id)) continue;
    const level = resolveEffectiveNotificationLevel(settings, ch);
    if (level === "all") allLevelIds.push(ch.id);
    else if (level === "mentions") mentionsLevelIds.push(ch.id);
  }
  if (allLevelIds.length === 0 && mentionsLevelIds.length === 0) return [];

  const runAggregation = (ids: string[], mentionsOnly: boolean) =>
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
      .from(communityChannel)
      .innerJoin(communityMessage, eq(communityMessage.channelId, communityChannel.id))
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
          inArray(communityChannel.id, jsonTextSet(db, ids)),
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
          ...(mentionsOnly ? [hasAttentionSql(userId, communityMessage.id)] : []),
        )
      )
      .groupBy(communityChannel.id);

  const [allRows, mentionRows] = await Promise.all([
    allLevelIds.length > 0 ? runAggregation(allLevelIds, false) : Promise.resolve([]),
    mentionsLevelIds.length > 0 ? runAggregation(mentionsLevelIds, true) : Promise.resolve([]),
  ]);

  return [...allRows, ...mentionRows];
}

export async function listUnreadForumOpeners(
  db: Database,
  userId: string,
  forumParentIds: string[],
  opts?: { limit?: number; settings?: NotificationSettingLookup }
): Promise<UnreadForumOpenerRow[]> {
  const uniqueParentIds = [...new Set(forumParentIds)];
  if (uniqueParentIds.length === 0) return [];
  const limit = Math.max(1, opts?.limit ?? DEFAULT_UNREAD_FORUM_OPENERS_LIMIT);

  const [forumMeta, settings] = await Promise.all([
    db
      .select({
        id: communityChannel.id,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
        type: communityChannel.type,
        archived: communityChannel.archived,
      })
      .from(communityChannel)
      .where(inArray(communityChannel.id, jsonTextSet(db, uniqueParentIds))),
    opts?.settings ? Promise.resolve(opts.settings) : loadUserNotificationSettingLookup(db, userId),
  ]);
  if (forumMeta.length === 0) return [];

  const allForumIds: string[] = [];
  const mentionsForumIds: string[] = [];
  for (const forum of forumMeta) {
    if (forum.parentChannelId !== null || forum.type !== "forum" || forum.archived !== 0) continue;
    const level = resolveEffectiveNotificationLevel(settings, forum);
    if (level === "all") allForumIds.push(forum.id);
    else if (level === "mentions") mentionsForumIds.push(forum.id);
  }
  if (allForumIds.length === 0 && mentionsForumIds.length === 0) return [];

  const runForumQuery = (ids: string[], mentionsOnly: boolean) => {
    const forumIds = jsonTextSet(db, ids).as("forum_inbox_ids");
    const childChannel = aliasedTable(communityChannel, "forum_inbox_child");
    return db
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
          ...(mentionsOnly ? [hasAttentionSql(userId, communityMessage.id)] : []),
        )
      )
      .orderBy(desc(communityMessage.createdAt), desc(communityMessage.seq), desc(communityMessage.id))
      .limit(limit);
  };

  const [allRows, mentionRows] = await Promise.all([
    allForumIds.length > 0 ? runForumQuery(allForumIds, false) : Promise.resolve([]),
    mentionsForumIds.length > 0 ? runForumQuery(mentionsForumIds, true) : Promise.resolve([]),
  ]);
  const rows = [...allRows, ...mentionRows];

  rows.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.openerSeq - a.openerSeq ||
      b.openerMessageId.localeCompare(a.openerMessageId)
  );

  return rows.slice(0, limit).map((row) => ({
    forumChannelId: row.forumChannelId,
    openerMessageId: row.openerMessageId,
    childChannelId: row.childChannelId,
    title:
      row.openerContent.trim().length > 0
        ? row.openerContent
        : row.childName?.trim() || "Thread",
    createdAt: row.createdAt,
    openerSeq: row.openerSeq,
  }));
}

export async function listThreadOpenersByChildIds(
  db: Database,
  userId: string,
  childIds: string[],
  opts?: { settings?: NotificationSettingLookup }
): Promise<ThreadOpenerRow[]> {
  if (childIds.length === 0) return [];

  const childChannel = aliasedTable(communityChannel, "thread_inbox_child_lookup");
  const parentChannel = aliasedTable(communityChannel, "thread_inbox_parent_lookup");
  const [rows, settings] = await Promise.all([
    db
      .select({
        parentChannelId: parentChannel.id,
        parentServerId: parentChannel.serverId,
        parentParentChannelId: parentChannel.parentChannelId,
        parentType: parentChannel.type,
        openerMessageId: communityMessage.id,
        openerContent: communityMessage.content,
        openerSeq: communityMessage.seq,
        childChannelId: childChannel.id,
        childName: childChannel.name,
        createdAt: communityMessage.createdAt,
        rawUnread: sql<number>`(
          (${communityReadState.id} IS NOT NULL AND ${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0))
          OR
          (${communityReadState.id} IS NULL AND ${communityMessage.createdAt} > ${communityServerMember.joinedAt})
        )`,
        hasAttention: hasAttentionSql(userId, communityMessage.id),
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
      ),
    opts?.settings ? Promise.resolve(opts.settings) : loadUserNotificationSettingLookup(db, userId),
  ]);

  rows.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.openerSeq - a.openerSeq ||
      b.openerMessageId.localeCompare(a.openerMessageId)
  );

  return rows.map((row) => {
    const level = resolveEffectiveNotificationLevel(settings, {
      id: row.parentChannelId,
      serverId: row.parentServerId,
      parentChannelId: row.parentParentChannelId,
    });
    const policyOk = level === "all" || (level === "mentions" && Boolean(row.hasAttention));
    return {
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
      openerUnread: Boolean(row.rawUnread) && policyOk,
    };
  });
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
  userId: string,
  opts?: { settings?: NotificationSettingLookup; dmChannelIds?: string[] }
): Promise<EligibleUnreadDmRow[]> {
  const [dmChannelIds, settings] = await Promise.all([
    opts?.dmChannelIds ? Promise.resolve(opts.dmChannelIds) : listReadableDmChannelIds(db, userId),
    opts?.settings ? Promise.resolve(opts.settings) : loadUserNotificationSettingLookup(db, userId),
  ]);
  if (dmChannelIds.length === 0) return [];

  const allDmIds: string[] = [];
  const mentionsDmIds: string[] = [];
  for (const dmId of new Set(dmChannelIds)) {
    const level = settings.byChannelId.get(dmId) ?? "all";
    if (level === "all") allDmIds.push(dmId);
    else if (level === "mentions") mentionsDmIds.push(dmId);
  }
  if (allDmIds.length === 0 && mentionsDmIds.length === 0) return [];

  const runDmQuery = (ids: string[], mentionsOnly: boolean) =>
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
      .from(communityChannel)
      .innerJoin(communityMessage, eq(communityMessage.channelId, communityChannel.id))
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
          inArray(communityChannel.id, jsonTextSet(db, ids)),
          isNull(user.deletedAt),
          ne(communityMessage.authorId, userId),
          gt(
            communityMessage.seq,
            sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`
          ),
          ...(mentionsOnly ? [hasAttentionSql(userId, communityMessage.id)] : []),
        )
      )
      .groupBy(communityChannel.id, user.id);

  const [allRows, mentionRows] = await Promise.all([
    allDmIds.length > 0 ? runDmQuery(allDmIds, false) : Promise.resolve([]),
    mentionsDmIds.length > 0 ? runDmQuery(mentionsDmIds, true) : Promise.resolve([]),
  ]);
  const rows = [...allRows, ...mentionRows];

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

export async function listDismissedQuestionMessageIdsForUser(
  db: Database,
  userId: string,
  messageIds: readonly string[],
): Promise<Set<string>> {
  const uniqueIds = [...new Set(messageIds.filter((id) => id.length > 0))];
  if (!userId || uniqueIds.length === 0) return new Set();
  const rows = (
    await Promise.all(
      chunk(uniqueIds, ELIGIBLE_UNREAD_CHANNEL_CHUNK_SIZE).map((ids) =>
        db
          .select({ messageId: communityQuestionTodo.messageId })
          .from(communityQuestionTodo)
          .where(
            and(
              eq(communityQuestionTodo.userId, userId),
              inArray(communityQuestionTodo.messageId, ids),
              isNotNull(communityQuestionTodo.dismissedAt),
            ),
          ),
      ),
    )
  ).flat();
  return new Set(rows.map((row) => row.messageId));
}
