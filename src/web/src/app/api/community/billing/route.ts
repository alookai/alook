import { BillingSummarySchema, queries } from "@alook/shared"
import { withOptionalAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { getBillingSummary } from "@/lib/billing/service"

export const GET = withOptionalAuth(async (req, ctx) => {
  if (req.headers.has("Authorization") || !ctx.userId || ctx.user?.isBot) return billingResponse({ error: "UNAUTHORIZED" }, 401)
  try {
    const db = getPrimaryDb(ctx.env.DB)
    const owner = await queries.user.getUserInternal(db, ctx.userId)
    if (!owner || owner.isBot || owner.deletedAt !== null) return billingResponse({ error: "UNAUTHORIZED" }, 401)
    const summary = await getBillingSummary(db, () => billingClient(ctx.env), ctx.env, ctx.userId)
    return billingResponse(BillingSummarySchema.parse(summary))
  } catch (error) {
    return billingFailure(error, "summary")
  }
})
