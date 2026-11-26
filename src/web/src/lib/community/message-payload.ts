
import { attachDecisionCardResponders, attachDecisionCardViewerDismissed, BUSINESS_SCHEMA_VERSION, CommunityMessageResourceSchema, CommunityMessageResourcesSchema, communityMessageProfileIds, DECISION_CARD_MESSAGE_TYPE, queries, type CommunityContract, type Database, type MentionType, type CommunityMessageResource, type CommunityMessageAttachment } from "@alook/shared"
import type { BotCreationPayload, FriendApprovalPayload } from "@alook/shared"

import { readCommunityResourceProfiles, type CommunityResourceProfileReader } from "./resource-profiles.server"
import { canonicalUserImage } from "@/lib/community/storage"
import { projectMessageWireType } from "@/lib/community/message-wire-type"
import { groupAttachments, groupReactions } from "./messages"

export type MessageRow = Pick<Awaited<ReturnType<typeof queries.communityMessage.getMessagesByIdsInScope>>[number],
  "id" | "authorId" | "authorName" | "authorImage" | "authorAvatarVersion" | "mentionType" | "replyToId" | "seq" | "createdAt"> & { content: string | null; type: string | null; embeds: unknown; clientNonce?: string | null; friendshipId?: string | null }

type ReplyIdentity = Pick<MessageRow, "id" | "authorId" | "authorName">

type UiReaction = NonNullable<CommunityMessageResource["reactions"]>[number]
type ReplyPreview = NonNullable<CommunityMessageResource["replyTo"]>
type ThreadPreview = NonNullable<CommunityMessageResource["thread"]>

function coreFields(row: MessageRow, replyMap: ReadonlyMap<string, ReplyIdentity>) {
  return {
    ...projectMessageWireType(row.type),
    replyTo: resolveReply(row, replyMap),
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatar: canonicalUserImage(row.authorId, row.authorImage, row.authorAvatarVersion),
    authorAvatarVersion: row.authorAvatarVersion,
    // `content` is nullable in the DB (empty message with attachments) but
    // both the API response and the WS payload treat it as string; coerce
    // once here so downstream consumers don't have to null-check.
    content: row.content ?? "",
    // The `type` column can hold "default" / "system" / "thread_created".
    // GET hides "default" (undefined = default), WS returns it explicitly —
    // both are correct; we keep the difference at the variant boundary below.
    seq: row.seq,
    createdAt: row.createdAt,
    mentionType: (row.mentionType ?? null) as MentionType | null,
    replyToId: row.replyToId,
  }
}

/**
 * Resolve the reply preview from a scope-checked replyMap. When `replyToId`
 * is set but the target is missing from the map (out-of-scope filtered out
 * upstream, or actually deleted), we return the `{ deleted: true }` sentinel
 * so the client renders "reply to [deleted]" without leaking data.
 */
function resolveReply(row: MessageRow, replyMap: ReadonlyMap<string, ReplyIdentity>): ReplyPreview | undefined {
  if (!row.replyToId) return undefined
  const target = replyMap.get(row.replyToId)
  if (!target) return { id: row.replyToId, authorName: "Deleted user", deleted: true }
  return {
    id: target.id,
    authorId: target.authorId,
    authorName: target.authorName,
  }
}

export type ApiMessageContext = {
  viewerId: string
  relatedMessages?: CommunityMessageResource[]
  replyMap: ReadonlyMap<string, ReplyIdentity>
  attachmentsByMessage: Record<string, CommunityMessageAttachment[] | undefined>
  reactionsByMessage: Record<string, UiReaction[] | undefined>
  /** Optional: only channel GET surfaces a thread child; DM/thread don't. */
  threadByMessageId?: Map<string, ThreadPreview>
  /** Optional: only the DM messages route hydrates friend-approval cards. */
  approvalByMessageId?: Map<string, FriendApprovalPayload>
  botCreationByMessageId?: Map<string, BotCreationPayload>
  respondedUserIdsByMessageId?: ReadonlyMap<string, readonly string[]>
  dismissedQuestionMessageIds?: ReadonlySet<string>
}

type MessageContextOptions = { skipEmpty?: boolean; rootReactions?: boolean; rootMessages?: readonly (Pick<MessageRow, "id" | "type" | "friendshipId"> & { channelId?: string })[] }

async function hydrateDecisionCardRespondersByChannel(
  db: Database,
  rows: readonly { id: string; type: string | null; channelId?: string }[],
): Promise<Map<string, string[]>> {
  const byChannel = new Map<string, string[]>()
  for (const row of rows) {
    if (row.type !== DECISION_CARD_MESSAGE_TYPE || !row.channelId) continue
    const list = byChannel.get(row.channelId) ?? []
    list.push(row.id)
    byChannel.set(row.channelId, list)
  }
  const merged = new Map<string, string[]>()
  if (byChannel.size === 0) return merged
  const entries = await Promise.all(
    [...byChannel.entries()].map(async ([channelId, questionIds]) => {
      const found = await queries.communityMessage.listReplierUserIdsByReplyTargets(db, channelId, questionIds)
      return { questionIds, found }
    }),
  )
  for (const { questionIds, found } of entries) {
    for (const id of questionIds) {
      merged.set(id, found.get(id) ?? [])
    }
  }
  return merged
}

async function loadReactionsByMessage(
  db: Database,
  messageIds: string[],
  userId: string,
): Promise<Record<string, UiReaction[] | undefined>> {
  if (messageIds.length === 0) return {}
  if (typeof queries.communityReaction.summarizeReactionsByMessageIds === "function") {
    return queries.communityReaction.summarizeReactionsByMessageIds(db, messageIds, userId)
  }
  const rows = await queries.communityReaction.listReactionsByMessageIds(db, messageIds)
  return groupReactions(rows, userId)
}

export async function loadApiMessageContext(db: Database, userId: string, ids: string[], readReplies: () => ReturnType<typeof queries.communityMessage.getMessagesByIdsInChannels>, options: MessageContextOptions = {}) {
  const [attachments, rootReactionsByMessage, replyRows] = await Promise.all([
    options.skipEmpty && !ids.length ? Promise.resolve([]) : queries.communityAttachment.listByMessageIds(db, ids),
    options.rootReactions === false || options.skipEmpty && !ids.length
      ? Promise.resolve<Record<string, UiReaction[] | undefined>>({})
      : loadReactionsByMessage(db, ids, userId),
    readReplies(),
  ])
  const replies = [...new Map(replyRows.map(reply => [`${reply.channelId}:${reply.id}`, reply])).values()]
  const related = replies.filter(reply => !ids.includes(reply.id))
  const relatedIds = related.map(reply => reply.id)
  const cardRows = [...new Map([...(options.rootMessages ?? []), ...related].map(row => [row.id, row])).values()]
  const questionCardIds = cardRows.filter(row => row.type === DECISION_CARD_MESSAGE_TYPE).map(row => row.id)
  const [replyAttachments, replyReactionsByMessage, approvalByMessageId, botCreationByMessageId, respondedUserIdsByMessageId, dismissedQuestionMessageIds] = await Promise.all([
    relatedIds.length ? queries.communityAttachment.listByMessageIds(db, relatedIds) : Promise.resolve([]),
    relatedIds.length ? loadReactionsByMessage(db, relatedIds, userId) : Promise.resolve<Record<string, UiReaction[] | undefined>>({}),
    cardRows.some(row => row.friendshipId) ? queries.communityFriendship.hydrateApprovalsForDmMessages(db, cardRows.filter(row => row.friendshipId).map(row => row.id), userId) : Promise.resolve(new Map<string, FriendApprovalPayload>()),
    cardRows.some(row => row.type === "bot_creation_request") ? queries.communityBotCreation.hydrateCreationRequestsForDmMessages(db, cardRows.filter(row => row.type === "bot_creation_request").map(row => row.id), userId) : Promise.resolve(new Map<string, BotCreationPayload>()),
    questionCardIds.length > 0 ? hydrateDecisionCardRespondersByChannel(db, cardRows) : Promise.resolve(new Map<string, string[]>()),
    questionCardIds.length > 0 ? queries.communityInbox.listDismissedQuestionMessageIdsForUser(db, userId, questionCardIds) : Promise.resolve(undefined),
  ])
  const attachmentsByMessage = groupAttachments([...attachments, ...replyAttachments])
  const reactionsByMessage: Record<string, UiReaction[] | undefined> = { ...rootReactionsByMessage, ...replyReactionsByMessage }
  return (channelId: string): ApiMessageContext => {
    const replyMap = new Map(replies.filter(reply => reply.channelId === channelId).map(reply => [reply.id, reply]))
    const context: ApiMessageContext = { viewerId: userId, attachmentsByMessage, reactionsByMessage, replyMap, approvalByMessageId, botCreationByMessageId, respondedUserIdsByMessageId, dismissedQuestionMessageIds }
    context.relatedMessages = [...replyMap.values()].filter(reply => !ids.includes(reply.id)).map(reply => {
      const resource = mapMessageForApi(reply, context, BUSINESS_SCHEMA_VERSION, channelId)
      delete resource.replyTo
      return resource
    })
    return context
  }
}

export async function readCommunityMessageResource(db: Database, userId: string, message: Parameters<typeof mapMessageForApi>[0] & { channelId: string }, contract: CommunityContract, options: MessageContextOptions = {}) {
  const context = await loadApiMessageContext(db, userId, [message.id], () => message.replyToId
    ? queries.communityMessage.getMessagesByIdsInScope(db, [message.replyToId], { channelId: message.channelId }) : Promise.resolve([]), { ...options, rootMessages: [message] })
  const ctx = context(message.channelId)
  return { message: mapMessageForApi(message, ctx, contract, message.channelId), relatedMessages: ctx.relatedMessages ?? [] }
}

// Splits the DB's `type` column value into the wire's `{ type, systemKind }`
// pair. `"thread_created"` was already documented above (and in the shared
// WS type, `CommunityMessageCreate.message.type`) as a possible column
// value — verified it was never actually written by any insert anywhere in
// this codebase, purely a placeholder for exactly this feature. Reused
// here (rather than inventing a new convention value) since it maps to
// `{ type: "system", systemKind: "thread" }` so `message.tsx`'s icon branch
// can distinguish it from a bare `type: "system"` row with no known kind
// (which stays `systemKind: undefined`, falling back to the generic icon).
// Ordinary messages map to `type: "chat"` (never `undefined`) now that
// `Msg.type` is a required, exhaustive discriminator (#12). The mapper lives
// in message-wire-type so cross-scope feeds (Mentions/Marked) use the exact
// same DB-to-wire normalization as channel message responses.

export function mapMessageForApi(row: MessageRow, ctx: ApiMessageContext, contract: number = BUSINESS_SCHEMA_VERSION, channelId?: string) {
  if (contract !== BUSINESS_SCHEMA_VERSION) throw new Error("Message resource protocol mismatch")
  return mapMessageResource(row, ctx, channelId, row.authorId === ctx.viewerId ? row.clientNonce ?? null : null)
}

function mapMessageResource(row: MessageRow, ctx: Omit<ApiMessageContext, "viewerId">, channelId: string | undefined, clientNonce: string | null) {
  const checkedResponders = row.type === DECISION_CARD_MESSAGE_TYPE && ctx.respondedUserIdsByMessageId?.has(row.id)
    ? (ctx.respondedUserIdsByMessageId.get(row.id) ?? []).filter((uid) => uid !== row.authorId)
    : undefined
  const checkedDismissed = row.type === DECISION_CARD_MESSAGE_TYPE && ctx.dismissedQuestionMessageIds !== undefined
    ? ctx.dismissedQuestionMessageIds.has(row.id)
    : undefined
  let embeds: unknown[] | undefined = Array.isArray(row.embeds) ? row.embeds : undefined
  if (embeds !== undefined && checkedResponders !== undefined) {
    embeds = attachDecisionCardResponders(embeds, checkedResponders)
  }
  if (embeds !== undefined && checkedDismissed !== undefined) {
    embeds = attachDecisionCardViewerDismissed(embeds, checkedDismissed)
  }
  return CommunityMessageResourceSchema.parse({
    ...coreFields(row, ctx.replyMap), channelId,
    authorAvatar: canonicalUserImage(row.authorId, row.authorImage, row.authorAvatarVersion),
    clientNonce: clientNonce && !clientNonce.startsWith("srv:") ? clientNonce : null,
    attachments: ctx.attachmentsByMessage[row.id] ?? [],
    ...(embeds !== undefined ? { embeds } : {}),
    reactions: ctx.reactionsByMessage[row.id], thread: ctx.threadByMessageId?.get(row.id),
    approval: ctx.approvalByMessageId?.get(row.id),
    botCreation: ctx.botCreationByMessageId?.get(row.id),
  })
}

export async function mapPostedMessageForApi(db: Database, channelId: string, row: MessageRow, contract: number = BUSINESS_SCHEMA_VERSION) {
  if (contract !== BUSINESS_SCHEMA_VERSION) throw new Error("Posted message protocol mismatch")
  return readCommunityMessageResource(db, row.authorId, { ...row, channelId }, contract, { rootReactions: false })
}

export type WsMessageContext = {
  replyMap: ReadonlyMap<string, ReplyIdentity>
  resourceAttachments: CommunityMessageAttachment[]
  clientNonce?: string
  botCreation?: BotCreationPayload
}

export function mapMessageForWs(row: MessageRow, ctx: WsMessageContext, contract: number = BUSINESS_SCHEMA_VERSION, channelId?: string) {
  if (contract !== BUSINESS_SCHEMA_VERSION) throw new Error("Message resource protocol mismatch")
  return mapMessageResource(row, {
    replyMap: ctx.replyMap, attachmentsByMessage: { [row.id]: ctx.resourceAttachments }, reactionsByMessage: {},
    botCreationByMessageId: ctx.botCreation ? new Map([[row.id, ctx.botCreation]]) : undefined,
  }, channelId, ctx.clientNonce ?? row.clientNonce ?? null)
}

export async function readCommunityMessageProfiles(db: Database, messages: readonly CommunityMessageResource[], readProfiles: CommunityResourceProfileReader = ids => readCommunityResourceProfiles(db, ids)) {
  const requiredIds = communityMessageProfileIds(messages)
  const profiles = CommunityMessageResourcesSchema.shape.profiles.parse(await readProfiles(requiredIds))
  const seenIds = new Set(profiles.map(profile => profile.id))
  if (seenIds.size !== profiles.length || requiredIds.some(id => !seenIds.has(id))) {
    throw new Error("Message profile missing or duplicated in resource graph")
  }
  return profiles
}
