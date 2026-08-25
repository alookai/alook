import { queries, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

/**
 * POST /api/community/users/me/inbox/dms/read-all
 *
 * Mark every DM the viewer participates in read at its latest message. Kept a
 * DISTINCT route from `/inbox/unreads/read-all` (channels) so the inbox
 * "mark all read" affordance fires three independent POSTs — mentions +
 * channel-unreads + dms — each idempotent and independently retryable.
 */
export const POST = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const { count, changed, revision } = await queries.communityReadState.markAllDmsRead(db, ctx.userId)
  if (changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.INBOX_CHANGED,
      revision,
      inboxChanged: true,
      reason: "read_all",
    })
  }
  return writeJSON({ ok: true, count, changed, revision })
})
