import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const pins = await queries.communityPin.listPins(db, channelId)
  return writeJSON({ pins })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  let body: { messageId: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.messageId) return writeError("missing messageId", 400)

  const pin = await queries.communityPin.pinMessage(db, {
    channelId,
    messageId: body.messageId,
    pinnedBy: ctx.userId,
  })

  fanOutToChannel(channelId, {
    type: "community:pin.add",
    channelId,
    messageId: body.messageId,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  queries.communityAuditLog.logAction(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "pin_add",
    targetType: "message",
    targetId: body.messageId,
  }).catch(() => {})

  return writeJSON(pin, 201)
})
