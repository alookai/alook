import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const messageId = ctx.params?.messageId
  if (!channelId || !messageId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  await queries.communityPin.unpinMessage(db, { channelId, messageId })

  fanOutToChannel(channelId, {
    type: "community:pin.remove",
    channelId,
    messageId,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  queries.communityAuditLog.logAction(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "pin_remove",
    targetType: "message",
    targetId: messageId,
  }).catch(() => {})

  return new Response(null, { status: 204 })
})
