import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireChannelAccess } from "@/lib/community/permissions"
import { listChildChannelsForApi } from "@/lib/community/channel-service"

/**
 * GET /api/community/channels/[id]/children?type=post|thread — the single
 * sub-channel list endpoint. Absorbs the old GET /channels/[id]/posts and
 * /channels/[id]/threads. Returns `200 { children: ChannelDTO[] }`.
 *
 *   - type=post   → the forum's posts (archived:false, optional ?tag= filter,
 *                   parent must be a forum, messageCount excludes the opener).
 *   - type=thread → the channel's threads (?archived tri-state, parentSeq set).
 */
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const type = req.nextUrl.searchParams.get("type")
  if (type !== "post" && type !== "thread") {
    return writeError("type must be 'post' or 'thread'", 400)
  }

  const db = getDb(ctx.env.DB)

  // A channel in a PRIVATE category must not leak its child list to non-members.
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  if (type === "post") {
    const tag = req.nextUrl.searchParams.get("tag")
    const result = await listChildChannelsForApi(db, access.value, channelId, { type: "post", tag })
    if (!result.ok) return writeError(result.error, result.status)
    return writeJSON({ children: result.children })
  }

  const archivedParam = req.nextUrl.searchParams.get("archived")
  const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined
  const result = await listChildChannelsForApi(db, access.value, channelId, { type: "thread", archived })
  if (!result.ok) return writeError(result.error, result.status)
  return writeJSON({ children: result.children })
})
