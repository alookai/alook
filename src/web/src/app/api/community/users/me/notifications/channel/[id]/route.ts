import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

const VALID_LEVELS = ["all", "mentions", "nothing"] as const

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Get channel to find serverId
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  // Verify membership in the server
  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  let body: { level: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.level || !VALID_LEVELS.includes(body.level as typeof VALID_LEVELS[number])) {
    return writeError("level must be one of: all, mentions, nothing", 400)
  }

  const setting = await queries.communityNotificationSetting.setChannelLevel(db, {
    userId: ctx.userId,
    channelId,
    level: body.level,
  })

  return writeJSON(setting)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Get channel to find serverId
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  // Verify membership in the server
  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  await queries.communityNotificationSetting.removeChannelOverride(db, {
    userId: ctx.userId,
    channelId,
  })

  return new Response(null, { status: 204 })
})
