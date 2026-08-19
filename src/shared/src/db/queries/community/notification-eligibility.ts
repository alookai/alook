import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  communityMention,
  communityMessage,
  communityChannel,
  communityNotificationSetting,
  communityReadState,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import type { NotificationLevelValue } from "../../../constants/community";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { channelReadableSql } from "./channel";

type SqlValue = string | number | SQLWrapper;

export type NotificationChannelSql = {
  id: SQLWrapper;
  serverId: SQLWrapper;
  parentChannelId: SQLWrapper;
};

export type NotificationMessageSql = {
  id: SQLWrapper;
};

export function currentEffectiveLevelSql(
  userId: SqlValue,
  channel: NotificationChannelSql,
) {
  return sql<NotificationLevelValue>`coalesce(
    (select ${communityNotificationSetting.level}
      from ${communityNotificationSetting}
      where ${communityNotificationSetting.userId} = ${userId}
        and ${communityNotificationSetting.channelId} = ${channel.id}
      limit 1),
    (select ${communityNotificationSetting.level}
      from ${communityNotificationSetting}
      where ${communityNotificationSetting.userId} = ${userId}
        and ${communityNotificationSetting.channelId} = ${channel.parentChannelId}
      limit 1),
    (select ${communityNotificationSetting.level}
      from ${communityNotificationSetting}
      where ${communityNotificationSetting.userId} = ${userId}
        and ${communityNotificationSetting.serverId} = ${channel.serverId}
        and ${communityNotificationSetting.channelId} is null
      limit 1),
    'all'
  )`;
}

export function hasAttentionSql(userId: SqlValue, messageId: SqlValue) {
  return sql<boolean>`exists(
    select 1 from ${communityMention}
    where ${communityMention.userId} = ${userId}
      and ${communityMention.messageId} = ${messageId}
  )`;
}

/** Snapshot's historical `mention` flag excludes reply-only attention. */
export function hasDirectMentionSql(userId: SqlValue, messageId: SqlValue) {
  return sql<boolean>`exists(
    select 1 from ${communityMention}
    where ${communityMention.userId} = ${userId}
      and ${communityMention.messageId} = ${messageId}
      and ${communityMention.kind} = 'mention'
  )`;
}

/** Web mention badges count only attention facts not dismissed in that tab. */
export function hasUnreadAttentionSql(userId: SqlValue, messageId: SqlValue) {
  return sql<boolean>`exists(
    select 1 from ${communityMention}
    where ${communityMention.userId} = ${userId}
      and ${communityMention.messageId} = ${messageId}
      and ${communityMention.read} = 0
  )`;
}

export function policyAllowsSql(level: SQLWrapper, hasAttention: SQLWrapper) {
  return sql<boolean>`case
    when ${level} = 'all' then 1
    when ${level} = 'mentions' then ${hasAttention}
    else 0
  end`;
}

/** Current-policy attention gate shared by every unread and wake surface. */
export function notificationEligibleSql(
  userId: SqlValue,
  channel: NotificationChannelSql,
  message: NotificationMessageSql,
) {
  const attention = hasAttentionSql(userId, message.id);
  return policyAllowsSql(currentEffectiveLevelSql(userId, channel), attention);
}

export type NotificationEligibilityState = {
  currentLevel: NotificationLevelValue;
  hasAttention: boolean;
  isUnread: boolean;
  isReadable: boolean;
};

/** Resolve current policy, attention, and cursor state in one batched snapshot. */
export async function resolveNotificationEligibilityForUsers(
  db: Database,
  userIds: string[],
  messageId: string,
): Promise<Map<string, NotificationEligibilityState>> {
  const result = new Map<string, NotificationEligibilityState>();
  if (userIds.length === 0) return result;

  const channelSql = {
    id: communityChannel.id,
    serverId: communityChannel.serverId,
    parentChannelId: communityChannel.parentChannelId,
  };
  const runChunk = (ids: string[]) => {
    const attention = hasAttentionSql(user.id, communityMessage.id);
    return db
      .select({
        userId: user.id,
        currentLevel: currentEffectiveLevelSql(user.id, channelSql),
        hasAttention: attention,
        isUnread: sql<boolean>`${communityMessage.seq} > coalesce(${communityReadState.lastReadSeq}, 0)`,
        isReadable: channelReadableSql(user.id, {
          id: communityChannel.id,
          type: communityChannel.type,
          serverId: communityChannel.serverId,
          parentChannelId: communityChannel.parentChannelId,
        }),
      })
      .from(user)
      .innerJoin(communityMessage, eq(communityMessage.id, messageId))
      .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, user.id),
          eq(communityReadState.channelId, communityMessage.channelId),
        ),
      )
      .where(inArray(user.id, ids));
  };

  const rows = (
    await Promise.all(chunk(userIds, D1_MAX_IN_PARAMS - 1).map(runChunk))
  ).flat();
  for (const row of rows) {
    result.set(row.userId, {
      currentLevel: row.currentLevel,
      hasAttention: Boolean(row.hasAttention),
      isUnread: Boolean(row.isUnread),
      isReadable: Boolean(row.isReadable),
    });
  }
  return result;
}
