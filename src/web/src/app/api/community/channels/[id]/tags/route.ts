import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireChannelAccess } from "@/lib/community/permissions"
import { queries } from "@alook/shared"

export const GET = withAuth(async (_req, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)
  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const tags = await queries.communityMessageTag.listDistinctTagsForChannel(db, channelId)
  return writeJSON({ tags })
})
