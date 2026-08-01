import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // `withD1Retry` (D1-armor: no-fallback settings read; retry a transient to the
  // true settings rather than 500 or a misleading empty set).
  const settings = await withD1Retry(
    () => queries.communityNotificationSetting.getSettings(db, ctx.userId),
    { route: "users/me/notifications" },
  )
  return writeJSON(settings)
})
