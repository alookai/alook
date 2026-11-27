import type {
  AccountAttentionProjection,
  AttentionItem,
  AttentionScope,
} from "../../../community-attention"
import {
  DECISION_CARD_MESSAGE_TYPE,
  isAssignedDecisionCardForUser,
} from "../../../community-decision-card"
import type { Database } from "../../index"
import { getChannelsByIds, listVisibleChannelIdsForUser } from "./channel"
import {
  listEligibleUnreadChannels,
  listEligibleUnreadDms,
  listPendingQuestionMessages,
  listReadableDmChannelIds,
  listReadableDmSummariesByChannelIds,
  listThreadOpenersByChildIds,
  listUnreadForumOpeners,
} from "./inbox"
import { loadUserNotificationSettingLookup } from "./notification-eligibility"
import { listUnreadMentions, listUnreadMentionScopes } from "./mention"
import { listActionableIncomingRequests } from "./friendship"
import { getServersByIds } from "./server"

export const DEFAULT_ATTENTION_ITEM_LIMIT = 100
export const MAX_ATTENTION_ITEM_LIMIT = 200
export const MAX_ATTENTION_TODO_LIMIT = 50

type IncludedProfile = AccountAttentionProjection["included"]["profiles"][number]
type IncludedMessage = AccountAttentionProjection["included"]["messages"][number]

/**
 * Stateless account-attention projection over the existing inbox facts.
 * Mention/reply rows follow `limit` and pending question Todo cards are
 * bounded by `todoLimit = Math.min(limit, MAX_ATTENTION_TODO_LIMIT)` so both
 * D1 scans and downstream channel/DM/message hydration stay bounded;
 * actionable friend requests stay complete.
 */
export async function getAccountAttentionProjection(
  db: Database,
  userId: string,
  requestedLimit = DEFAULT_ATTENTION_ITEM_LIMIT,
): Promise<AccountAttentionProjection> {
  const limit = Math.max(1, Math.min(requestedLimit, MAX_ATTENTION_ITEM_LIMIT))
  const todoLimit = Math.max(1, Math.min(limit, MAX_ATTENTION_TODO_LIMIT))
  const [visibleChannelIds, readableDmChannelIds, notificationSettings] = await Promise.all([
    listVisibleChannelIdsForUser(db, userId),
    listReadableDmChannelIds(db, userId),
    loadUserNotificationSettingLookup(db, userId),
  ])
  const readableDmIdSet = new Set(readableDmChannelIds)
  const [channelRows, dmRows, friendRows, mentionScopeRows, allMentionRows, rawPendingQuestionRows] = await Promise.all([
    listEligibleUnreadChannels(db, userId, visibleChannelIds, { settings: notificationSettings }),
    listEligibleUnreadDms(db, userId, { settings: notificationSettings, dmChannelIds: readableDmChannelIds }),
    listActionableIncomingRequests(db, userId),
    listUnreadMentionScopes(db, userId, visibleChannelIds),
    listUnreadMentions(db, userId, {
      limit: limit + 1,
      visibleChannelIds,
    }),
    listPendingQuestionMessages(db, userId, visibleChannelIds, readableDmChannelIds, {
      limit: todoLimit + 1,
    }),
  ])
  const allAssignedQuestionRows = rawPendingQuestionRows.filter((row) => (
    isAssignedDecisionCardForUser(row.embeds, userId, readableDmIdSet.has(row.channelId))
  ))
  const hasMoreTodos = allAssignedQuestionRows.length > todoLimit
  const assignedQuestionRows = allAssignedQuestionRows.slice(0, todoLimit)

  const attentionByScope = new Map(mentionScopeRows.map((row) => [row.channelId, row]))
  const scopesById = new Map<string, AttentionScope>()
  for (const row of channelRows) {
    const attention = attentionByScope.get(row.channelId)
    scopesById.set(row.channelId, {
      scopeId: row.channelId,
      channelId: row.channelId,
      serverId: row.serverId,
      parentChannelId: row.parentChannelId,
      ordinaryUnread: true,
      lastUnreadSeq: row.lastUnreadSeq,
      unreadCount: row.unreadCount,
      lastAttentionSeq: attention?.lastAttentionSeq ?? null,
      attentionCount: attention?.attentionCount ?? 0,
    })
  }
  for (const row of dmRows) {
    scopesById.set(row.channelId, {
      scopeId: row.channelId,
      channelId: row.channelId,
      serverId: null,
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: row.lastUnreadSeq,
      unreadCount: row.unreadCount,
      lastAttentionSeq: null,
      attentionCount: 0,
    })
  }
  for (const row of mentionScopeRows) {
    if (scopesById.has(row.channelId)) continue
    scopesById.set(row.channelId, {
      scopeId: row.channelId,
      channelId: row.channelId,
      serverId: row.serverId,
      parentChannelId: row.parentChannelId,
      ordinaryUnread: false,
      lastUnreadSeq: row.lastAttentionSeq,
      lastAttentionSeq: row.lastAttentionSeq,
      attentionCount: row.attentionCount,
    })
  }
  const preliminaryScopes = [...scopesById.values()]

  const forumParentIds = [...new Set(channelRows.flatMap((row) => (
    !row.parentChannelId && row.type === "forum" ? [row.channelId] : []
  )))]
  const unreadChildIds = [...new Set(preliminaryScopes.flatMap((scope) => (
    scope.serverId && scope.parentChannelId ? [scope.channelId] : []
  )))]
  const unreadDmIdSet = new Set(dmRows.map((row) => row.channelId))
  const missingQuestionDmIds = [...new Set(assignedQuestionRows.flatMap((row) => (
    readableDmIdSet.has(row.channelId) && !unreadDmIdSet.has(row.channelId) ? [row.channelId] : []
  )))]
  const questionServerChannelIds = [...new Set(assignedQuestionRows.flatMap((row) => (
    readableDmIdSet.has(row.channelId) ? [] : [row.channelId]
  )))]
  const [allForumOpeners, childThreadOpeners, extraQuestionDmRows] = await Promise.all([
    listUnreadForumOpeners(db, userId, forumParentIds, { limit: limit + 1, settings: notificationSettings }),
    listThreadOpenersByChildIds(db, userId, unreadChildIds, { settings: notificationSettings }),
    listReadableDmSummariesByChannelIds(db, userId, missingQuestionDmIds),
  ])
  const forumOpenersTruncated = allForumOpeners.length > limit
  const displayedForumOpeners = allForumOpeners.slice(0, limit)
  const childThreadOpenerByChildId = new Map(
    childThreadOpeners.map((opener) => [opener.childChannelId, opener]),
  )
  const displayedForumOpenerByChildId = new Map(
    displayedForumOpeners.map((opener) => [opener.childChannelId, opener]),
  )
  const channelOwnerIds = [...new Set([
    ...preliminaryScopes.flatMap((scope) => scope.serverId ? [scope.channelId] : []),
    ...preliminaryScopes.flatMap((scope) => scope.parentChannelId ? [scope.parentChannelId] : []),
    ...displayedForumOpeners.map((opener) => opener.childChannelId),
    ...questionServerChannelIds,
  ])]
  const initialChannelOwners = await getChannelsByIds(db, channelOwnerIds)
  const initialChannelOwnerIds = new Set(initialChannelOwners.map((channel) => channel.id))
  const missingQuestionParentIds = [...new Set(initialChannelOwners.flatMap((channel) => (
    channel.parentChannelId && !initialChannelOwnerIds.has(channel.parentChannelId)
      ? [channel.parentChannelId]
      : []
  )))]
  const extraParentChannels = missingQuestionParentIds.length > 0
    ? await getChannelsByIds(db, missingQuestionParentIds)
    : []
  const channelOwners = [...initialChannelOwners, ...extraParentChannels]
  const includedChannels = channelOwners.flatMap((channel) => {
    if (
      !channel.serverId
      || !channel.name
      || channel.type !== "text" && channel.type !== "forum" && channel.type !== "thread"
    ) return []
    const opener = childThreadOpenerByChildId.get(channel.id)
      ?? displayedForumOpenerByChildId.get(channel.id)
    return [{
      id: channel.id,
      serverId: channel.serverId,
      name: channel.name,
      type: channel.type,
      parentChannelId: channel.parentChannelId ?? null,
      parentMessageId: channel.parentMessageId ?? null,
      creatorId: channel.creatorId ?? null,
      archived: channel.archived === true || channel.archived === 1,
      lastMessageAt: channel.lastMessageAt ?? null,
      ...(opener ? {
        openerSeq: opener.openerSeq,
        openerUnread: "openerUnread" in opener ? opener.openerUnread : true,
      } : {}),
    }]
  })
  const channelOwnerById = new Map(includedChannels.map((channel) => [channel.id, channel]))
  const serverOwnerIds = [...new Set(includedChannels.map((channel) => channel.serverId))]
  const serverOwners = await getServersByIds(db, serverOwnerIds)
  const includedServers = serverOwners.map((server) => ({
    id: server.id,
    name: server.name,
    discriminator: server.discriminator,
  }))
  const serverOwnerById = new Map(includedServers.map((server) => [server.id, server]))
  const includedDms = [
    ...dmRows.map((row) => ({
      id: row.channelId,
      userId: row.otherUserId,
      name: row.otherUserName,
      discriminator: row.otherUserDiscriminator,
      avatar: row.otherUserImage,
      avatarVersion: row.otherUserAvatarVersion,
      lastMessageAt: row.lastMessageAt,
      lastUnreadSeq: row.lastUnreadSeq,
    })),
    ...extraQuestionDmRows.map((row) => ({
      id: row.channelId,
      userId: row.otherUserId,
      name: row.otherUserName,
      discriminator: row.otherUserDiscriminator,
      avatar: row.otherUserImage,
      avatarVersion: row.otherUserAvatarVersion,
      lastMessageAt: row.lastMessageAt,
      lastUnreadSeq: 0,
    })),
  ]
  const dmOwnerById = new Map(includedDms.map((dm) => [dm.id, dm]))
  const scopes = preliminaryScopes.filter((scope) => {
    if (!scope.serverId) return dmOwnerById.has(scope.channelId)
    const channel = channelOwnerById.get(scope.channelId)
    if (!channel || channel.serverId !== scope.serverId || !serverOwnerById.has(scope.serverId)) {
      return false
    }
    if (!scope.parentChannelId) return channel.parentChannelId === null
    const parent = channelOwnerById.get(scope.parentChannelId)
    const opener = childThreadOpenerByChildId.get(scope.channelId)
    return channel.parentChannelId === scope.parentChannelId
      && parent?.serverId === scope.serverId
      && channel.parentMessageId === opener?.openerMessageId
  })
  const survivingScopeIds = new Set(scopes.map((scope) => scope.scopeId))

  // The aggregate and bounded item reads are independent primary statements.
  // A mention may be created/deleted between them, so fence the composed
  // result against the aggregate-owned scope set before validating the wire
  // snapshot. A reverse race may leave a scope with no item until reconcile,
  // which remains schema-valid and preserves its exact aggregate count.
  const eligibleMentionRows = allMentionRows.filter((row) => (
    Boolean(row.message.channelId && survivingScopeIds.has(row.message.channelId))
  ))
  const displayedMentionRows = eligibleMentionRows.slice(0, limit)
  const exactMentionCount = mentionScopeRows.reduce(
    (total, row) => total + row.attentionCount,
    0,
  )
  const mentionItems: AttentionItem[] = displayedMentionRows.map((row) => ({
    id: `mention:${row.mention.id}`,
    kind: row.mention.kind === "reply" ? "reply" : "mention",
    sourceId: row.mention.id,
    scopeId: row.message.channelId,
    messageId: row.message.id,
    actorUserId: row.author.id,
    createdAt: row.message.createdAt,
  }))
  const forumItems: AttentionItem[] = displayedForumOpeners.flatMap((row) => {
    const scope = scopesById.get(row.forumChannelId)
    const parent = channelOwnerById.get(row.forumChannelId)
    const child = channelOwnerById.get(row.childChannelId)
    if (
      !scope
      || !survivingScopeIds.has(scope.scopeId)
      || parent?.type !== "forum"
      || child?.type !== "thread"
      || child.parentChannelId !== parent.id
      || child.parentMessageId !== row.openerMessageId
    ) return []
    return [{
      id: `forum_post:${row.childChannelId}`,
      kind: "forum_post" as const,
      sourceId: row.childChannelId,
      scopeId: scope.scopeId,
      messageId: row.openerMessageId,
      actorUserId: null,
      childChannelId: row.childChannelId,
      openerSeq: row.openerSeq,
      readTarget: { channelId: row.forumChannelId, seq: row.openerSeq },
      createdAt: row.createdAt,
    }]
  })
  const friendItems: AttentionItem[] = friendRows.map((row) => ({
    id: `friend_request:${row.id}`,
    kind: "friend_request",
    sourceId: row.id,
    scopeId: null,
    messageId: null,
    actorUserId: row.userId,
    createdAt: row.createdAt,
  }))
  const eligibleQuestionRows = assignedQuestionRows.filter((row) => {
    const channel = channelOwnerById.get(row.channelId)
    if (channel && serverOwnerById.has(channel.serverId)) return true
    return dmOwnerById.has(row.channelId)
  })
  const questionItems: AttentionItem[] = eligibleQuestionRows.map((row) => ({
    id: `question:${row.id}`,
    kind: "question",
    sourceId: row.id,
    scopeId: row.channelId,
    messageId: row.id,
    actorUserId: row.authorId,
    createdAt: row.createdAt,
  }))
  const items = [...mentionItems, ...forumItems, ...questionItems, ...friendItems]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))

  const includedProfiles = new Map<string, IncludedProfile>()
  for (const row of friendRows) {
    includedProfiles.set(row.userId, {
      userId: row.userId,
      name: row.name,
      discriminator: row.discriminator,
      avatar: row.image ?? "",
      avatarVersion: row.avatarVersion,
    })
  }
  for (const row of displayedMentionRows) {
    includedProfiles.set(row.author.id, {
      userId: row.author.id,
      name: row.author.name,
      discriminator: row.author.discriminator,
      avatar: row.author.image,
      avatarVersion: row.author.avatarVersion,
    })
  }
  for (const row of eligibleQuestionRows) {
    includedProfiles.set(row.authorId, {
      userId: row.authorId,
      name: row.authorName,
      discriminator: row.authorDiscriminator,
      avatar: row.authorImage,
      avatarVersion: row.authorAvatarVersion,
    })
  }
  for (const row of [...dmRows, ...extraQuestionDmRows]) {
    includedProfiles.set(row.otherUserId, {
      userId: row.otherUserId,
      name: row.otherUserName,
      discriminator: row.otherUserDiscriminator,
      avatar: row.otherUserImage,
      avatarVersion: row.otherUserAvatarVersion,
    })
  }
  const includedMessages = new Map<string, IncludedMessage>(
    displayedMentionRows.map((row): [string, IncludedMessage] => [row.message.id, {
      id: row.message.id,
      channelId: row.message.channelId!,
      type: row.message.type === "system"
        ? "system"
        : row.message.type === DECISION_CARD_MESSAGE_TYPE
          ? "question"
          : "chat",
      authorId: row.author.id,
      authorName: row.author.name,
      seq: row.message.seq,
      createdAt: row.message.createdAt,
      content: row.message.content ?? "",
    }]),
  )
  for (const row of eligibleQuestionRows) {
    if (includedMessages.has(row.id)) continue
    includedMessages.set(row.id, {
      id: row.id,
      channelId: row.channelId,
      type: "question",
      authorId: row.authorId,
      authorName: row.authorName,
      seq: row.seq,
      createdAt: row.createdAt,
      content: row.content ?? "",
    })
  }
  const openerByMessageId = new Map(
    [...childThreadOpeners, ...displayedForumOpeners.map((row) => ({
      parentChannelId: row.forumChannelId,
      openerMessageId: row.openerMessageId,
      title: row.title,
      createdAt: row.createdAt,
      openerSeq: row.openerSeq,
    }))].map((row) => [row.openerMessageId, row]),
  )
  for (const row of openerByMessageId.values()) {
    if (includedMessages.has(row.openerMessageId)) continue
    includedMessages.set(row.openerMessageId, {
      id: row.openerMessageId,
      channelId: row.parentChannelId,
      type: "chat",
      seq: row.openerSeq,
      createdAt: row.createdAt,
      content: row.title,
    })
  }

  return {
    scopes,
    items,
    limit,
    truncated: exactMentionCount > limit || forumOpenersTruncated,
    todosTruncated: hasMoreTodos,
    included: {
      servers: includedServers,
      channels: includedChannels,
      dms: includedDms,
      profiles: [...includedProfiles.values()],
      messages: [...includedMessages.values()],
    },
  }
}
