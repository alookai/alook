import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToDM } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)

  // Fetch attachments for all messages
  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = groupAttachments(allAttachments)

  // Fetch reactions for all messages
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

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const otherUserId = dm.user1Id === ctx.userId ? dm.user2Id : dm.user1Id

  // Check if blocked
  const blocked = await queries.communityFriendship.isBlocked(db, ctx.userId, otherUserId!)
  if (blocked) return writeError("blocked", 403)

  let body: { content: string; replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }

  const created = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    dmConversationId: dmId,
    replyToId: body.replyToId,
  })

  // Create attachment records
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

  // Fetch with author join for the response
  const row = await queries.communityMessage.getMessage(db, created.id)

  // Create mention for the replied-to user (unless replying to self)
  if (body.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, body.replyToId)
    if (replyMsg && replyMsg.authorId && replyMsg.authorId !== ctx.userId) {
      await queries.communityMention.createMentions(db, { messageId: created.id, userIds: [replyMsg.authorId], kind: "reply" })
      broadcastToUser(replyMsg.authorId, {
        type: "community:mention.create",
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
    type: "community:message.create",
    dmConversationId: dmId,
    message,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  if (otherUserId) {
    broadcastToUser(otherUserId, {
      type: "community:dm.new_message",
      dmConversationId: dmId,
      message,
    } as never).catch(() => {})
  }

  return writeJSON({ message }, 201)
})
