import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToThread } from "@/lib/community/fanout"

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

  const cursorCreatedAt = req.nextUrl.searchParams.get("cursor_created_at")
  const cursorId = req.nextUrl.searchParams.get("cursor_id")
  const limitParam = req.nextUrl.searchParams.get("limit")

  const cursor =
    cursorCreatedAt && cursorId
      ? { createdAt: cursorCreatedAt, id: cursorId }
      : undefined

  const messages = await queries.communityMessage.listMessages(db, {
    threadId,
    cursor,
    limit: limitParam ? parseInt(limitParam, 10) : undefined,
  })

  return writeJSON(messages)
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

  let body: { content: string; replyToId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content) return writeError("content is required", 400)

  const message = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    threadId,
    replyToId: body.replyToId,
  })

  fanOutToThread(threadId, {
    type: "community:message.create",
    threadId,
    message,
  } as never, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(message, 201)
})
