import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isThread } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { channelIds?: unknown }
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  const ids = Array.isArray(body.channelIds) ? body.channelIds.filter((id): id is string => typeof id === "string") : []
  if (ids.length > 100) return writeError("too many ids", 400)
  const db = getDb(ctx.env.DB)
  for (const channelId of ids) {
    const access = await requireChannelAccess(db, channelId, ctx.userId)
    if (!access.ok) return writeError(access.error, access.status)
    if (!isThread(access.value.channel.type)) return writeError("participants require thread channels", 400)
  }
  const participants = await queries.communityThread.listParticipantsForChannels(db, ids)
  return writeJSON({ participants })
})
