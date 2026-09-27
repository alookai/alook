import type {
  AccountAttentionSnapshot,
  AttentionItem,
  AttentionScope,
} from "../../../community-attention"
import type { Database } from "../../index"
import { listVisibleChannelIdsForUser } from "./channel"
import { listEligibleUnreadChannels, listEligibleUnreadDms } from "./inbox"
import { listUnreadMentions, listUnreadMentionScopes } from "./mention"
import { listActionableIncomingRequests } from "./friendship"

export const DEFAULT_ATTENTION_ITEM_LIMIT = 100
export const MAX_ATTENTION_ITEM_LIMIT = 200

/**
 * Stateless account-attention projection over the existing inbox facts.
 * The item cap applies only to mention/reply rows; actionable friend requests
 * stay complete so every consumer can derive an exact badge from this result.
 */
export async function getAccountAttentionSnapshot(
  db: Database,
  userId: string,
  requestedLimit = DEFAULT_ATTENTION_ITEM_LIMIT,
): Promise<AccountAttentionSnapshot> {
  const limit = Math.max(1, Math.min(requestedLimit, MAX_ATTENTION_ITEM_LIMIT))
  const visibleChannelIds = await listVisibleChannelIdsForUser(db, userId)
  const [channelRows, dmRows, friendRows, mentionScopeRows, allMentionRows] = await Promise.all([
    listEligibleUnreadChannels(db, userId, visibleChannelIds),
    listEligibleUnreadDms(db, userId),
    listActionableIncomingRequests(db, userId),
    listUnreadMentionScopes(db, userId, visibleChannelIds),
    listUnreadMentions(db, userId, {
      limit: limit + 1,
      visibleChannelIds,
    }),
  ])

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
  const scopes = [...scopesById.values()]

  // The aggregate and bounded item reads are independent primary statements.
  // A mention may be created/deleted between them, so fence the composed
  // result against the aggregate-owned scope set before validating the wire
  // snapshot. A reverse race may leave a scope with no item until reconcile,
  // which remains schema-valid and preserves its exact aggregate count.
  const eligibleMentionRows = allMentionRows.filter((row) => (
    Boolean(row.message.channelId && scopesById.has(row.message.channelId))
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
  const friendItems: AttentionItem[] = friendRows.map((row) => ({
    id: `friend_request:${row.id}`,
    kind: "friend_request",
    sourceId: row.id,
    scopeId: null,
    messageId: null,
    actorUserId: row.userId,
    createdAt: row.createdAt,
  }))
  const items = [...mentionItems, ...friendItems]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))

  const includedProfiles = new Map<string, Record<string, unknown>>()
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
      avatar: row.author.image ?? "",
      avatarVersion: row.author.avatarVersion,
    })
  }
  const includedMessages = displayedMentionRows.map((row) => ({
    id: row.message.id,
    channelId: row.message.channelId!,
    type: row.message.type === "system" ? "system" : "chat",
    authorId: row.author.id,
    authorName: row.author.name,
    seq: row.message.seq,
    createdAt: row.message.createdAt,
    content: row.message.content ?? "",
  }))

  return {
    scopes,
    items,
    limit,
    truncated: exactMentionCount > limit,
    included: {
      profiles: [...includedProfiles.values()],
      messages: includedMessages,
    },
  }
}
