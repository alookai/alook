import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { readAnalyticsConsent } from "@/lib/analytics-consent"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const scope = req.nextUrl.searchParams.get("event") ?? "legacy"
  if (scope !== "legacy" && scope !== "invited_human_joined") return writeError("invalid event scope", 400)
  const events = scope === "invited_human_joined" && readAnalyticsConsent(req.headers.get("cookie") ?? "") === "denied" ? [] : await queries.communityFunnelAnalytics.claimPendingEvents(
    getPrimaryDb(ctx.env.DB),
    ctx.userId,
    scope,
  )
  const response = writeJSON({ events })
  response.headers.set("Cache-Control", "no-store")
  return response
})
