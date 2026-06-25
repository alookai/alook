import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToThread } from "@/lib/community/fanout"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
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
    threadId,
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

  const messages = items.map((r) => ({
    ...r,
    attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
  }))

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
  if (!channel) return writeError("channel not found", 404)

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
    threadId,
    replyToId: body.replyToId,
  })

  // Create attachment records
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

  fanOutToThread(threadId, {
    type: "community:message.create",
    threadId,
    message,
  } as never, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(message, 201)
})
