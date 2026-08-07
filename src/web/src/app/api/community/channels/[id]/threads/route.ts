import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_FORUM_TAG_LENGTH } from "@alook/shared"
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

  let childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived,
    type: "thread",
  })

  const rawTag = req.nextUrl.searchParams.get("tag")
  if (rawTag !== null) {
    const tag = rawTag.trim().toLowerCase()
    if (!tag) return writeError("tag is required", 400)
    if (tag.length > MAX_FORUM_TAG_LENGTH) return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)
    const openerIds = childChannels.map((child) => child.parentMessageId).filter((id): id is string => !!id)
    const matching = new Set(await queries.communityMessageTag.filterMessageIdsByTag(db, openerIds, tag))
    childChannels = childChannels.filter((child) => !!child.parentMessageId && matching.has(child.parentMessageId))
  }

  // Plain nested collection representation. View-specific parent previews,
  // first messages, tags, participants, and creator presentation are composed
  // by consumers through the generic batch resource reads.
  return writeJSON({ threads: childChannels })
})
