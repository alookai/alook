import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { channelId?: unknown; ids?: unknown; firstInChannelIds?: unknown }
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : []
  const firstInChannelIds = Array.isArray(body.firstInChannelIds)
    ? [...new Set(body.firstInChannelIds.filter((id): id is string => typeof id === "string"))]
    : []
  if (ids.length > 100 || firstInChannelIds.length > 100) return writeError("too many ids", 400)
  if (typeof body.channelId !== "string") return writeError("channelId is required", 400)

  const db = getDb(ctx.env.DB)
  const parentAccess = await requireMessageSurfaceAccess(db, body.channelId, ctx.userId)
  if (!parentAccess.ok) return writeError(parentAccess.error, parentAccess.status)
  const messages = await queries.communityMessage.getMessagesByIdsInScope(db, ids, { channelId: body.channelId })
  const childThreads = await queries.communityChannel.getDirectChildThreadsByIds(db, body.channelId, firstInChannelIds)
  if (childThreads.length !== firstInChannelIds.length) return writeError("thread not found", 404)
  const firstMessages = await queries.communityMessage.getFirstMessageByChannelIds(db, firstInChannelIds)
  return writeJSON({ messages, firstMessages })
})
