import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withCookieHumanAuth(async (_req, ctx) => {
  const events = await queries.communityFunnelAnalytics.claimPendingEvents(
    getPrimaryDb(ctx.env.DB),
    ctx.userId,
  )
  const response = writeJSON({ events })
  response.headers.set("Cache-Control", "no-store")
  return response
})
