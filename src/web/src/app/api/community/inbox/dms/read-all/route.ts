import { queries, withD1Retry } from "@alook/shared"
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
 *
 * `withD1Retry` (D1-armor state 3, idempotent write): mark-read is a set-to-a-
 * value write, safe to re-run, so a transient D1 blip retries instead of a 500.
 */
export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const count = await withD1Retry(
    () => queries.communityReadState.markAllDmsRead(db, ctx.userId),
    { route: "inbox/dms/read-all" },
  )
  return writeJSON({ ok: true, count })
})
