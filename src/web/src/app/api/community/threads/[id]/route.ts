import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  return writeJSON(thread)
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { name?: string; archived?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; archived?: number } = {}
  if (body.name !== undefined) changes.name = body.name
  if (body.archived !== undefined) changes.archived = body.archived ? 1 : 0

  const updated = await queries.communityThread.updateThread(db, threadId, changes)
  if (!updated) return writeError("thread not found", 404)

  fanOutToChannel(thread.channelId, {
    type: "community:thread.update",
    channelId: thread.channelId,
    threadId,
    changes: body,
  } as never, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(updated)
})
