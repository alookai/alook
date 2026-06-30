import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { requireServerAdmin } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { channelIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) {
    return writeError("channelIds must be a non-empty array", 400)
  }
  const unique = new Set(body.channelIds)
  if (unique.size !== body.channelIds.length) {
    return writeError("channelIds must be unique", 400)
  }

  const channels = await queries.communityChannel.getChannelsByIds(db, body.channelIds)
  if (channels.length !== body.channelIds.length) {
    return writeError("one or more channels not found", 404)
  }
  if (channels.some((ch) => ch.serverId !== serverId)) {
    return writeError("channel does not belong to this server", 400)
  }

  await queries.communityChannel.reorderChannels(db, serverId, body.channelIds)

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CHANNEL_REORDER,
    serverId,
    channels: body.channelIds.map((id, i) => ({ id, position: i })),
  })

  return writeJSON({ ok: true })
})
