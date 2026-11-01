import { withAuth } from "@/lib/middleware/auth-policy"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const settings = await queries.communityNotificationSetting.getSettings(db, ctx.userId)
  return writeJSON(settings)
})
