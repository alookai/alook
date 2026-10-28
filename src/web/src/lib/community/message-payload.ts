/**
 * Single source of truth for turning a message row into an on-the-wire
 * payload. Two variants:
 *
 * - `mapMessageForApi` — response shape for GET /messages endpoints
 *   (channels, DMs, threads). Attachments are already grouped into the UI
 *   shape ({ kind: "image" | "file", name, url, size? }) upstream.
 *
 * - `mapMessageForWs` — payload shape for WS MESSAGE_CREATE broadcasts.
 *   Attachments are raw ({ id, filename, url, contentType, size }) — the
 *   client re-shapes on receipt (see `contexts/community/context.tsx`).
 *
 * Both variants share reply-preview resolution, author-avatar derivation,
 * embeds pass-through, and mentionType projection so adding/removing a
 * field on the wire is one edit, not four.
 */
import { BUSINESS_SCHEMA_VERSION, CommunityMessageResourceSchema, CommunityMessageResourcesSchema, communityMessageProfileIds, queries, truncateMessagePreview, type CommunityContract, type Database, type MentionType, type CommunityMessageResource, type CommunityMessageAttachment } from "@alook/shared"
import type { BotCreationPayload, FriendApprovalPayload } from "@alook/shared"

import { readCommunityResourceProfiles } from "./resource-profiles.server"
import { canonicalUserImage } from "@/lib/community/storage"
import { projectMessageWireType } from "@/lib/community/message-wire-type"
import { groupAttachments, groupReactions } from "./messages"

export type MessageRow = Pick<Awaited<ReturnType<typeof queries.communityMessage.getMessagesByIdsInScope>>[number],
  "id" | "authorId" | "authorName" | "authorImage" | "authorAvatarVersion" | "mentionType" | "replyToId" | "seq" | "createdAt"> & { content: string | null; type: string | null; embeds: unknown; clientNonce?: string | null; friendshipId?: string | null }

type ReplyTargetRow = Pick<MessageRow, "id" | "authorId" | "authorName" | "content">

type UiReaction = NonNullable<CommunityMessageResource["reactions"]>[number]
type ReplyPreview = NonNullable<CommunityMessageResource["replyTo"]>
type ThreadPreview = NonNullable<CommunityMessageResource["thread"]>

/** Common fields shared by both API and WS variants — derived exactly once. */
function coreFields(row: MessageRow, replyMap: Map<string, ReplyTargetRow>) {
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
function resolveReply(row: MessageRow, replyMap: Map<string, ReplyTargetRow>): ReplyPreview | undefined {
  if (!row.replyToId) return undefined
  const target = replyMap.get(row.replyToId)
  if (!target) return { id: row.replyToId, authorName: "Deleted user", text: "", deleted: true }
  return {
    id: target.id,
    authorId: target.authorId,
    authorName: target.authorName,
    text: truncateMessagePreview(target.content ?? ""),
  }
}

export type ApiMessageContext = {
  viewerId: string
  replyMap: Map<string, ReplyTargetRow>
  attachmentsByMessage: Record<string, CommunityMessageAttachment[] | undefined>
  reactionsByMessage: Record<string, UiReaction[] | undefined>
  /** Optional: only channel GET surfaces a thread child; DM/thread don't. */
  threadByMessageId?: Map<string, ThreadPreview>
  /** Optional: only the DM messages route hydrates friend-approval cards. */
  approvalByMessageId?: Map<string, FriendApprovalPayload>
  botCreationByMessageId?: Map<string, BotCreationPayload>
}

export async function loadApiMessageContext(db: Database, userId: string, ids: string[], readReplies: () => ReturnType<typeof queries.communityMessage.getMessagesByIdsInChannels>, skipEmpty = false) {
  const [attachments, reactions, replies] = await Promise.all([
    skipEmpty && !ids.length ? Promise.resolve([]) : queries.communityAttachment.listByMessageIds(db, ids),
    skipEmpty && !ids.length ? Promise.resolve([]) : queries.communityReaction.listReactionsByMessageIds(db, ids, userId),
    readReplies(),
  ])
  const attachmentsByMessage = groupAttachments(attachments), reactionsByMessage = groupReactions(reactions, userId)
  return (channelId: string): ApiMessageContext => ({ viewerId: userId, attachmentsByMessage, reactionsByMessage,
    replyMap: new Map(replies.filter((reply) => reply.channelId === channelId).map((reply) => [reply.id, reply])),
  })
}

export async function readCommunityMessageResource(db: Database, userId: string, message: Parameters<typeof mapMessageForApi>[0] & { channelId: string }, contract: CommunityContract) {
  const context = await loadApiMessageContext(db, userId, [message.id], () => message.replyToId
    ? queries.communityMessage.getMessagesByIdsInScope(db, [message.replyToId], { channelId: message.channelId }) : Promise.resolve([]))
  const botCreationByMessageId = message.type === "bot_creation_request" ? await queries.communityBotCreation.hydrateCreationRequestsForDmMessages(db, [message.id], userId) : new Map<string, BotCreationPayload>()
  return mapMessageForApi(message, { ...context(message.channelId), botCreationByMessageId }, contract, message.channelId)
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
  return CommunityMessageResourceSchema.parse({
    ...coreFields(row, ctx.replyMap), channelId,
    authorAvatar: canonicalUserImage(row.authorId, row.authorImage, row.authorAvatarVersion),
    clientNonce: clientNonce && !clientNonce.startsWith("srv:") ? clientNonce : null,
    attachments: ctx.attachmentsByMessage[row.id] ?? [],
    ...(Array.isArray(row.embeds) ? { embeds: row.embeds } : {}),
    reactions: ctx.reactionsByMessage[row.id], thread: ctx.threadByMessageId?.get(row.id),
    approval: ctx.approvalByMessageId?.get(row.id),
    botCreation: ctx.botCreationByMessageId?.get(row.id),
  })
}

export async function mapPostedMessageForApi(db: Database, channelId: string, row: MessageRow, contract: number = BUSINESS_SCHEMA_VERSION) {
  if (contract !== BUSINESS_SCHEMA_VERSION) throw new Error("Posted message protocol mismatch")
  const [replies, attachments] = await Promise.all([
    row.replyToId ? queries.communityMessage.getMessagesByIdsInScope(db, [row.replyToId], { channelId }) : Promise.resolve([]),
    queries.communityAttachment.listByMessageIds(db, [row.id]),
  ])
  const replyMap = new Map(replies.filter(reply => reply.channelId === channelId).map(reply => [reply.id, reply]))
  return mapMessageForApi(row, { viewerId: row.authorId, replyMap, attachmentsByMessage: groupAttachments(attachments), reactionsByMessage: {} }, contract, channelId)
}

export type WsMessageContext = {
  replyMap: Map<string, ReplyTargetRow>
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


export async function readCommunityMessageProfiles(db: Database, messages: readonly CommunityMessageResource[]) {
  const profiles = await readCommunityResourceProfiles(db, communityMessageProfileIds(messages))
  CommunityMessageResourcesSchema.parse({ messages, profiles })
  return profiles
}
