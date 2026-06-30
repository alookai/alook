import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToDM } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import {
  requireDMParticipant,
  requireNotBlocked,
  otherDmParticipant,
} from "@/lib/community/permissions"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // A blocked relationship hides historical messages from the blocked party.
  const other = otherDmParticipant(auth.value, ctx.userId)
  const block = await requireNotBlocked(db, ctx.userId, other)
  if (!block.ok) return writeError(block.error, block.status)

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)

  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = groupAttachments(allAttachments)

  const allReactions = messageIds.length > 0
    ? await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
    : []

  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  const messages = items.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    authorName: r.authorName ?? r.authorEmail ?? "Unknown",
    authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
    content: r.content,
    type: r.type === "system" ? "system" as const : undefined,
    mentionType: r.mentionType,
    replyToId: r.replyToId,
    createdAt: r.createdAt,
    embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
    attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
    reactions: reactionsByMessage[r.id]?.length ? reactionsByMessage[r.id] : undefined,
  }))

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const otherUserId = otherDmParticipant(auth.value, ctx.userId)
  const block = await requireNotBlocked(db, ctx.userId, otherUserId)
  if (!block.ok) return writeError(block.error, block.status)

  let body: { content: string; replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }
  if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }
  if (body.attachments && body.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return writeError(`too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`, 400)
  }

  const created = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    dmConversationId: dmId,
    replyToId: body.replyToId,
  })

  let createdAttachments: { id: string; filename: string; url: string; contentType: string | null; size: number | null }[] = []
  if (body.attachments?.length) {
    createdAttachments = await Promise.all(
      body.attachments.map((att) =>
        queries.communityAttachment.createAttachment(db, {
          messageId: created.id,
          filename: att.filename,
          url: att.url,
          contentType: att.contentType,
          size: att.size,
        })
      )
    )
  }

  const row = await queries.communityMessage.getMessage(db, created.id)

  if (body.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, body.replyToId)
    if (replyMsg && replyMsg.authorId && replyMsg.authorId !== ctx.userId) {
      await queries.communityMention.createMentions(db, { messageId: created.id, userIds: [replyMsg.authorId], kind: "reply" })
      broadcastToUser(replyMsg.authorId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId: replyMsg.authorId,
        messageId: created.id,
        authorName: row?.authorName ?? "Unknown",
      } as never).catch(() => {})
    }
  }

  const message = {
    id: row!.id,
    authorId: row!.authorId,
    authorName: row!.authorName ?? "Unknown",
    authorAvatar: row!.authorImage ?? (row!.authorName ?? "?").charAt(0).toUpperCase(),
    content: row!.content,
    type: row!.type as "default" | "system" | "thread_created" | undefined,
    mentionType: row!.mentionType as "everyone" | "here" | null | undefined,
    replyToId: row!.replyToId,
    embeds: row!.embeds ? JSON.parse(row!.embeds) : undefined,
    attachments: createdAttachments.length > 0 ? createdAttachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      url: att.url,
      contentType: att.contentType ?? undefined,
      size: att.size ?? undefined,
    })) : undefined,
    createdAt: row!.createdAt,
  }

  fanOutToDM(dmId, {
    type: WS_EVENTS.MESSAGE_CREATE,
    dmConversationId: dmId,
    message,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  broadcastToUser(otherUserId, {
    type: WS_EVENTS.DM_NEW_MESSAGE,
    dmConversationId: dmId,
    message,
  } as never).catch(() => {})

  return writeJSON({ message }, 201)
})
