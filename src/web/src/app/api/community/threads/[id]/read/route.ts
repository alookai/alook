import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { lastReadMessageId?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional
  }

  const result = await queries.communityReadState.markRead(db, {
    userId: ctx.userId,
    threadId,
    lastReadAt: new Date().toISOString(),
    lastReadMessageId: body.lastReadMessageId,
  })

  return writeJSON(result)
})
