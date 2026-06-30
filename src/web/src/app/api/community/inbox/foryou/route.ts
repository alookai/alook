import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const events = await queries.communityInbox.listForYouEvents(db, ctx.userId)
  return writeJSON({ events })
})
