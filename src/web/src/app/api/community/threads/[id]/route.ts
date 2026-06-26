import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  return writeJSON(channel)
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("not found", 404)

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

  const updated = await queries.communityChannel.updateChannel(db, channelId, changes)
  if (!updated) return writeError("not found", 404)

  if (channel.parentChannelId) {
    fanOutToChannel(channel.parentChannelId, {
      type: "community:channel.child_update",
      parentChannelId: channel.parentChannelId,
      channelId,
      changes: body,
    } as never, { excludeUserId: ctx.userId }).catch(() => {})
  }

  return writeJSON(updated)
})
