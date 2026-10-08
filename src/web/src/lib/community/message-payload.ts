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
import { queries, truncateMessagePreview, type Database, type MentionType, type CommunityMessageResource, type CommunityMessageAttachment, type CommunityMessageCreate } from "@alook/shared"
import type { FriendApprovalPayload } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"
import { projectMessageWireType } from "@/lib/community/message-wire-type"
import { groupAttachments, groupReactions } from "./messages"

export type MessageRow = {
  id: string
  authorId: string
  authorName: string
  authorImage: string | null
  authorAvatarVersion: number
  content: string | null
  type: string | null
  mentionType: string | null
  replyToId: string | null
  embeds: unknown
  seq: number
  createdAt: string
  clientNonce?: string | null
  /** Friend-approval card back-ref — set only on approval card messages. */
  friendshipId?: string | null
}

type ReplyTargetRow = Pick<MessageRow, "id" | "authorId" | "authorName" | "content">

type UiAttachment = CommunityMessageAttachment
type WsAttachment = NonNullable<CommunityMessageCreate["message"]["attachments"]>[number]
type UiReaction = NonNullable<CommunityMessageResource["reactions"]>[number]
type ReplyPreview = NonNullable<CommunityMessageResource["replyTo"]>
type ThreadPreview = NonNullable<CommunityMessageResource["thread"]>

/** Common fields shared by both API and WS variants — derived exactly once. */
function coreFields(row: MessageRow) {
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatar: canonicalUserImage(row.authorId, row.authorImage, row.authorAvatarVersion)
      ?? avatarInitial(row.authorName),
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
  replyMap: Map<string, ReplyTargetRow>
  attachmentsByMessage: Record<string, UiAttachment[] | undefined>
  reactionsByMessage: Record<string, UiReaction[] | undefined>
  /** Optional: only channel GET surfaces a thread child; DM/thread don't. */
  threadByMessageId?: Map<string, ThreadPreview>
  /** Optional: only the DM messages route hydrates friend-approval cards. */
  approvalByMessageId?: Map<string, FriendApprovalPayload>
}

export async function loadApiMessageContext(db: Database, userId: string, ids: string[], readReplies: () => ReturnType<typeof queries.communityMessage.getMessagesByIdsInChannels>, skipEmpty = false) {
  const [attachments, reactions, replies] = await Promise.all([
    skipEmpty && !ids.length ? Promise.resolve([]) : queries.communityAttachment.listByMessageIds(db, ids),
    skipEmpty && !ids.length ? Promise.resolve([]) : queries.communityReaction.listReactionsByMessageIds(db, ids, userId),
    readReplies(),
  ])
  const attachmentsByMessage = groupAttachments(attachments), reactionsByMessage = groupReactions(reactions, userId)
  return (channelId: string): ApiMessageContext => ({ attachmentsByMessage, reactionsByMessage,
    replyMap: new Map(replies.filter((reply) => reply.channelId === channelId).map((reply) => [reply.id, reply])),
  })
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

export function mapMessageForApi(row: MessageRow, ctx: ApiMessageContext) {
  const core = coreFields(row)
  const thread = ctx.threadByMessageId?.get(row.id)
  const approval = ctx.approvalByMessageId?.get(row.id)
  const clientNonce =
    row.clientNonce && !row.clientNonce.startsWith("srv:") ? row.clientNonce : undefined
  return {
    ...core,
    ...projectMessageWireType(row.type),
    ...(clientNonce ? { clientNonce } : {}),
    replyTo: resolveReply(row, ctx.replyMap),
    embeds: row.embeds,
    attachments: ctx.attachmentsByMessage[row.id]?.length ? ctx.attachmentsByMessage[row.id] : undefined,
    reactions: ctx.reactionsByMessage[row.id]?.length ? ctx.reactionsByMessage[row.id] : undefined,
    thread,
    approval,
  }
}

export type WsMessageContext = {
  replyMap: Map<string, ReplyTargetRow>
  attachments: WsAttachment[]
  /**
   * The sender's client-provided idempotency nonce, echoed on the broadcast so
   * the sender's optimistic row can be reconciled in place (see
   * `CommunityMessageCreate.message.clientNonce`). Pass the RAW client nonce
   * (undefined when the client sent none); the `srv:`-prefixed server fallback
   * is filtered out below so a content fingerprint never reaches the wire.
   */
  clientNonce?: string
}

export function mapMessageForWs(row: MessageRow, ctx: WsMessageContext) {
  const core = coreFields(row)
  // Echo ONLY a client-provided nonce, and never the `srv:`-prefixed server
  // fallback (a content fingerprint — a content-correlation leak on the
  // broadcast wire, and a fallback send has no client optimistic row to match
  // anyway). The prefix guard is defense-in-depth: callers pass the raw client
  // nonce, but if a `srv:` value ever reaches here it is dropped, not fanned.
  const clientNonce =
    ctx.clientNonce && !ctx.clientNonce.startsWith("srv:") ? ctx.clientNonce : undefined
  return {
    ...core,
    ...projectMessageWireType(row.type),
    ...(clientNonce ? { clientNonce } : {}),
    replyTo: resolveReply(row, ctx.replyMap),
    // The shared CommunityMessageCreate.embeds is `unknown[]` — narrow here
    // rather than widening the wire type.
    embeds: Array.isArray(row.embeds) ? row.embeds : undefined,
    attachments:
      ctx.attachments.length > 0
        ? ctx.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            url: a.url,
            thumbnailUrl: a.thumbnailUrl,
            contentType: a.contentType,
            size: a.size,
            width: a.width,
            height: a.height,
          }))
        : undefined,
  }
}
