import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PUT = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  await queries.communityReadState.markRead(db, {
    userId: ctx.userId,
    channelId,
    lastReadAt: new Date().toISOString(),
  })

  // Also mark any mentions in this channel as read
  await queries.communityMention.markChannelMentionsRead(db, ctx.userId, channelId)

  return writeJSON({ ok: true })
})
