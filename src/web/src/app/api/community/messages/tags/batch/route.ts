import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { channelId?: unknown; messageIds?: unknown }
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  const ids = Array.isArray(body.messageIds) ? body.messageIds.filter((id): id is string => typeof id === "string") : []
  if (ids.length > 100) return writeError("too many ids", 400)
  if (typeof body.channelId !== "string") return writeError("channelId is required", 400)
  const db = getDb(ctx.env.DB)
  const access = await requireMessageSurfaceAccess(db, body.channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const messages = await queries.communityMessage.getMessagesByIdsInScope(db, ids, { channelId: body.channelId })
  const tags = await queries.communityMessageTag.listTagsForMessages(db, messages.map((message) => message.id))
  return writeJSON({ tags })
})
