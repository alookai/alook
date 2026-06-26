import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const cursorParam = req.nextUrl.searchParams.get("cursor")
  const limitParam = req.nextUrl.searchParams.get("limit")

  let cursor: { createdAt: string; id: string } | undefined
  if (cursorParam) {
    const [createdAt, id] = cursorParam.split("|")
    if (createdAt && id) cursor = { createdAt, id }
  }

  const pageSize = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 100) : 50

  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const hasMore = rows.length > pageSize
  const items = hasMore ? rows.slice(0, pageSize) : rows
  const nextCursor = hasMore && items.length > 0
    ? `${items[items.length - 1].createdAt}|${items[items.length - 1].id}`
    : undefined

  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = allAttachments.reduce((acc, att) => {
    if (!acc[att.messageId]) acc[att.messageId] = []
    const isImage = att.contentType?.startsWith("image/") ?? false
    acc[att.messageId].push(isImage
      ? { kind: "image" as const, name: att.filename, url: att.url }
      : { kind: "file" as const, name: att.filename, url: att.url, size: att.size ? formatBytes(att.size) : "Unknown" }
    )
    return acc
  }, {} as Record<string, Array<{ kind: "image"; name: string; url: string } | { kind: "file"; name: string; url: string; size: string }>>)

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
    createdAt: r.createdAt,
    embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
    attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
    reactions: reactionsByMessage[r.id] ? [...reactionsByMessage[r.id].values()] : undefined,
  }))

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { content: string; replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }

  const message = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    channelId,
    replyToId: body.replyToId,
  })

  if (body.attachments?.length) {
    await Promise.all(
      body.attachments.map((att) =>
        queries.communityAttachment.createAttachment(db, {
          messageId: message.id,
          filename: att.filename,
          url: att.url,
          contentType: att.contentType,
          size: att.size,
        })
      )
    )
  }

  fanOutToChannel(channelId, {
    type: "community:message.create",
    channelId,
    message,
  } as never, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(message, 201)
})
