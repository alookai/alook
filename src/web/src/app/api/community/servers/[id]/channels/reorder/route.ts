import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, canManageServer } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || !canManageServer(member.role)) {
    return writeError("forbidden", 403)
  }

  let body: { channelIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.channelIds) || body.channelIds.length === 0) {
    return writeError("channelIds must be a non-empty array", 400)
  }

  await queries.communityChannel.reorderChannels(db, serverId, body.channelIds)

  await fanOutToServerMembers(serverId, {
    type: "community:channel.reorder",
    serverId,
    channels: body.channelIds.map((id, i) => ({ id, position: i })),
  })

  return writeJSON({ ok: true })
})
