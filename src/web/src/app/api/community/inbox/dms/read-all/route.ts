import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

/**
 * POST /api/community/inbox/dms/read-all
 *
 * Mark every DM the viewer participates in read at its latest message. Kept a
 * DISTINCT route from `/inbox/unreads/read-all` (channels) so the inbox
 * "mark all read" affordance fires three independent POSTs — mentions +
 * channel-unreads + dms — each idempotent and independently retryable.
 */
export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const count = await queries.communityReadState.markAllDmsRead(db, ctx.userId)
  return writeJSON({ ok: true, count })
})
