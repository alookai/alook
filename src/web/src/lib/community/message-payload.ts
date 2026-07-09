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
import { MESSAGE_PREVIEW_LENGTH, type MentionType } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"

// The subset of fields on rows returned by
// queries.communityMessage.{listMessages, getMessage, getMessagesByIds} that
// this mapper actually consumes. Structural-typed so the module doesn't
// reach into the shared query package — a row with additional columns
// (channelId, dmConversationId, authorEmail, flags, …) is still accepted.
// Those columns are scope-filtered / used by the route BEFORE the row
// reaches this mapper; the mapper deliberately doesn't see them.
export type MessageRow = {
  id: string
  authorId: string
  authorName: string
  authorImage: string | null
  content: string | null
  type: string | null
  mentionType: string | null
  replyToId: string | null
  embeds: unknown
  createdAt: string
}

type ReplyTargetRow = { id: string; authorName: string; content: string | null }

type UiAttachment = { kind: "image" | "file"; name: string; url: string; size?: string }
type WsAttachment = { id: string; filename: string; url: string; contentType?: string; size?: number }
type UiReaction = { emoji: string; count: number; me: boolean; userIds: string[] }

type ReplyPreview = { id: string; authorName: string; text: string; deleted?: boolean }

type ThreadPreview = { id: string; name: string; messageCount: number }

/** Common fields shared by both API and WS variants — derived exactly once. */
function coreFields(row: MessageRow) {
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatar: row.authorImage ?? avatarInitial(row.authorName),
    // `content` is nullable in the DB (empty message with attachments) but
    // both the API response and the WS payload treat it as string; coerce
    // once here so downstream consumers don't have to null-check.
    content: row.content ?? "",
    // The `type` column can hold "default" / "system" / "thread_created".
    // GET hides "default" (undefined = default), WS returns it explicitly —
    // both are correct; we keep the difference at the variant boundary below.
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
  if (!target) return { id: row.replyToId, authorName: "Unknown", text: "", deleted: true }
  return {
    id: target.id,
    authorName: target.authorName,
    text: (target.content ?? "").slice(0, MESSAGE_PREVIEW_LENGTH),
  }
}

export type ApiMessageContext = {
  replyMap: Map<string, ReplyTargetRow>
  attachmentsByMessage: Record<string, UiAttachment[] | undefined>
  reactionsByMessage: Record<string, UiReaction[] | undefined>
  /** Optional: only channel GET surfaces a thread child; DM/thread don't. */
  threadByMessageId?: Map<string, ThreadPreview>
}

export function mapMessageForApi(row: MessageRow, ctx: ApiMessageContext) {
  const core = coreFields(row)
  const thread = ctx.threadByMessageId?.get(row.id)
  return {
    ...core,
    // GET convention: hide "default" (undefined = default). Preserved from
    // the pre-refactor per-route behaviour.
    type: row.type === "system" ? ("system" as const) : undefined,
    replyTo: resolveReply(row, ctx.replyMap),
    embeds: row.embeds,
    attachments: ctx.attachmentsByMessage[row.id]?.length ? ctx.attachmentsByMessage[row.id] : undefined,
    reactions: ctx.reactionsByMessage[row.id]?.length ? ctx.reactionsByMessage[row.id] : undefined,
    thread: thread ? { id: thread.id, name: thread.name, messageCount: thread.messageCount } : undefined,
  }
}

export type WsMessageContext = {
  replyMap: Map<string, ReplyTargetRow>
  attachments: WsAttachment[]
}

export function mapMessageForWs(row: MessageRow, ctx: WsMessageContext) {
  const core = coreFields(row)
  return {
    ...core,
    // WS convention: return "default" explicitly. Matches CommunityMessageCreate
    // in @alook/shared where `type?: "default" | "system" | "thread_created"`.
    type: (row.type as "default" | "system" | "thread_created") ?? "default",
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
            contentType: a.contentType,
            size: a.size,
          }))
        : undefined,
  }
}
