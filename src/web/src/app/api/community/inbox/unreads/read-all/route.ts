import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

// `withD1Retry` (D1-armor state 3): the whole mark-all is idempotent (resolve
// visible channels + set them read), safe to re-run on a transient. Wrapped as
// one unit so the visible-channel read and the mark-read retry together.
export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const count = await withD1Retry(
    async () => {
      // Resolve the viewer's visible channels once (top-level + threads/forum-
      // posts, parent-climbed) and scope the mark-all to them — a private thread
      // under an invisible parent is excluded.
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(
        db,
        ctx.userId,
      )
      return queries.communityReadState.markAllServerChannelsRead(
        db,
        ctx.userId,
        visibleChannelIds,
      )
    },
    { route: "inbox/unreads/read-all" },
  )
  return writeJSON({ ok: true, count })
})
