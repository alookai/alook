import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"

// `withD1Retry` (D1-armor state 3, idempotent write): mark-all-mentions-read is
// a set-to-read write, safe to re-run, so a transient D1 blip retries not 500s.
export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  await withD1Retry(() => queries.communityMention.markAllMentionsRead(db, ctx.userId), {
    route: "inbox/mentions/read-all",
  })
  return writeJSON({ ok: true })
})
