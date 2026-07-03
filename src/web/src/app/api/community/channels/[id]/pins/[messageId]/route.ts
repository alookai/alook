import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireServerAdmin } from "@/lib/community/permissions"
import { logAudit } from "@/lib/community/audit"

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const messageId = ctx.params?.messageId
  if (!channelId || !messageId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  // Unpinning is a moderation action — require admin / owner.
  const auth = await requireServerAdmin(db, channel.serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  await queries.communityPin.unpinMessage(db, { channelId, messageId })

  fanOutToChannel(channelId, {
    type: WS_EVENTS.PIN_REMOVE,
    channelId,
    messageId,
  }, { excludeUserId: ctx.userId })

  logAudit(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "pin_remove",
    targetType: "message",
    targetId: messageId,
  })

  return new Response(null, { status: 204 })
})
