import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // `withD1Retry` (D1-armor: no-fallback list read; retry to truth).
  const machines = await withD1Retry(() => queries.communityMachine.listMachinesForUser(db, ctx.userId), {
    route: "machines/list",
  })
  return writeJSON({ machines })
})
