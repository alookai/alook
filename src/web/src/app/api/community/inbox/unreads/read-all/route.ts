import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // Resolve the viewer's visible channels once (top-level + threads/forum-posts,
  // parent-climbed) and scope the mark-all to them — a private thread under an
  // invisible parent is excluded.
  const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
  const count = await queries.communityReadState.markAllServerChannelsRead(db, ctx.userId, visibleChannelIds)
  return writeJSON({ ok: true, count })
})
