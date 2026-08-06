import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { parentChannelId?: unknown; channelIds?: unknown }
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  const ids = Array.isArray(body.channelIds) ? [...new Set(body.channelIds.filter((id): id is string => typeof id === "string"))] : []
  if (ids.length > 100) return writeError("too many ids", 400)
  if (typeof body.parentChannelId !== "string") return writeError("parentChannelId is required", 400)
  const db = getDb(ctx.env.DB)
  const parentAccess = await requireMessageSurfaceAccess(db, body.parentChannelId, ctx.userId)
  if (!parentAccess.ok) return writeError(parentAccess.error, parentAccess.status)
  const childThreads = await queries.communityChannel.getDirectChildThreadsByIds(db, body.parentChannelId, ids)
  if (childThreads.length !== ids.length) return writeError("thread not found", 404)
  const participants = await queries.communityThread.listParticipantsForChannels(db, ids)
  return writeJSON({ participants })
})
