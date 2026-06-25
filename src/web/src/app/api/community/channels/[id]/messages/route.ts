import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const cursorCreatedAt = req.nextUrl.searchParams.get("cursor_created_at")
  const cursorId = req.nextUrl.searchParams.get("cursor_id")
  const limitParam = req.nextUrl.searchParams.get("limit")

  const cursor =
    cursorCreatedAt && cursorId
      ? { createdAt: cursorCreatedAt, id: cursorId }
      : undefined

  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 100) : undefined

  const messages = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit,
  })

  return writeJSON(messages)
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { content?: string; replyToId?: string; mentionType?: string }
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

  const message = await queries.communityMessage.getMessage(db, created.id)

  fanOutToChannel(channelId, {
    type: "community:message.create",
    channelId,
    message: {
      id: message!.id,
      authorId: message!.authorId,
      authorName: message!.authorName ?? "",
      authorAvatar: message!.authorImage ?? undefined,
      content: message!.content,
      type: (message!.type as "default" | "system" | "thread_created") ?? "default",
      mentionType: message!.mentionType as "everyone" | "here" | null,
      replyToId: message!.replyToId,
      createdAt: message!.createdAt,
    },
  }).catch(() => {})

  return writeJSON(message, 201)
})
