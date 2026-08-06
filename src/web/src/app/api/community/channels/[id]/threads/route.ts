import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Gate through the shared access predicate: a channel in a PRIVATE category
  // must not leak its thread titles/previews to non-members. Public channels
  // behave as before (any server member).
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const archivedParam = req.nextUrl.searchParams.get("archived")
  const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined

  const childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived,
    type: "thread",
  })

  // Plain nested collection representation. View-specific parent previews,
  // first messages, tags, participants, and creator presentation are composed
  // by consumers through the generic batch resource reads.
  return writeJSON({ threads: childChannels })
})
