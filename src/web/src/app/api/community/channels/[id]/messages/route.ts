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
  if (!channel) return writeError("channel not found", 404)

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

  // Resolve replyTo references
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]
  const replyMessages = replyToIds.length > 0
    ? await Promise.all(replyToIds.map((id) => queries.communityMessage.getMessage(db, id)))
    : []
  const replyMap = new Map(replyMessages.filter(Boolean).map((m) => [m!.id, m!]))

  const messages = items.map((r) => {
    const reply = r.replyToId ? replyMap.get(r.replyToId) : null
    return {
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName ?? r.authorEmail ?? "Unknown",
      authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
      content: r.content,
      type: r.type === "system" ? "system" as const : undefined,
      mentionType: r.mentionType,
      replyTo: reply ? { id: reply.id, authorName: reply.authorName ?? "Unknown", text: (reply.content ?? "").slice(0, 100) } : r.replyToId ? { id: r.replyToId, authorName: "Unknown", text: "", deleted: true } : undefined,
      createdAt: r.createdAt,
      embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
      attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
    }
  })

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { content?: string; replyToId?: string; mentionType?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
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
    channelId,
    replyToId: body.replyToId,
    mentionType: body.mentionType,
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

  const message = await queries.communityMessage.getMessage(db, created.id)

  // Resolve reply reference for WS event + create mention for replied-to user
  let replyTo: { id: string; authorName: string; text: string } | undefined
  if (message!.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, message!.replyToId)
    if (replyMsg) {
      replyTo = { id: replyMsg.id, authorName: replyMsg.authorName ?? "Unknown", text: (replyMsg.content ?? "").slice(0, 100) }
      // Create mention for the replied-to user (unless replying to self)
      if (replyMsg.authorId && replyMsg.authorId !== ctx.userId) {
        queries.communityMention.createMentions(db, { messageId: created.id, userIds: [replyMsg.authorId] }).catch(() => {})
      }
    }
  }

  fanOutToChannel(channelId, {
    type: "community:message.create",
    channelId,
    message: {
      id: message!.id,
      authorId: message!.authorId,
      authorName: message!.authorName ?? "",
      authorAvatar: message!.authorImage ?? (message!.authorName ?? "?").charAt(0).toUpperCase(),
      content: message!.content,
      type: (message!.type as "default" | "system" | "thread_created") ?? "default",
      mentionType: message!.mentionType as "everyone" | "here" | null,
      replyTo,
      createdAt: message!.createdAt,
    },
  }, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON({ message }, 201)
})
