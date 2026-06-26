import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToDM } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const cursorParam = req.nextUrl.searchParams.get("cursor")
  const limitParam = req.nextUrl.searchParams.get("limit")

  let cursor: { createdAt: string; id: string } | undefined
  if (cursorParam) {
    const [createdAt, id] = cursorParam.split("|")
    if (createdAt && id) cursor = { createdAt, id }
  }

  const pageSize = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 100) : 50

  const rows = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
    cursor,
    limit: pageSize + 1,
  })

  const hasMore = rows.length > pageSize
  const items = hasMore ? rows.slice(0, pageSize) : rows
  const nextCursor = hasMore && items.length > 0
    ? `${items[items.length - 1].createdAt}|${items[items.length - 1].id}`
    : undefined

  // Fetch attachments for all messages
  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  // Group attachments by message ID, mapped to frontend Attachment type
  const attachmentsByMessage = allAttachments.reduce((acc, att) => {
    if (!acc[att.messageId]) acc[att.messageId] = []
    const isImage = att.contentType?.startsWith("image/") ?? false
    acc[att.messageId].push(isImage
      ? { kind: "image" as const, name: att.filename, url: att.url }
      : { kind: "file" as const, name: att.filename, url: att.url, size: att.size ? formatBytes(att.size) : "Unknown" }
    )
    return acc
  }, {} as Record<string, Array<{ kind: "image"; name: string; url: string } | { kind: "file"; name: string; url: string; size: string }>>)

  // Fetch reactions for all messages
  const allReactions = messageIds.length > 0
    ? await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
    : []

  const reactionsByMessage = allReactions.reduce((acc, r) => {
    if (!acc[r.messageId]) acc[r.messageId] = new Map<string, { emoji: string; count: number; me: boolean }>()
    const map = acc[r.messageId]
    const existing = map.get(r.emoji)
    if (existing) {
      existing.count += 1
      if (r.userId === ctx.userId) existing.me = true
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, me: r.userId === ctx.userId })
    }
    return acc
  }, {} as Record<string, Map<string, { emoji: string; count: number; me: boolean }>>)

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
    reactions: reactionsByMessage[r.id] ? [...reactionsByMessage[r.id].values()] : undefined,
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
  if (blocked) return writeError("forbidden", 403)

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
  if (body.attachments?.length) {
    await Promise.all(
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
