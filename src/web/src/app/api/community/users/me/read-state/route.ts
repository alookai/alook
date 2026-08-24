import { queries, withD1Retry } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const snapshot = await withD1Retry(
    () => queries.communityReadState.getAccountReadStateSnapshot(db, ctx.userId),
    { route: "community/read-state-snapshot" },
  )
  return writeJSON(snapshot)
})
