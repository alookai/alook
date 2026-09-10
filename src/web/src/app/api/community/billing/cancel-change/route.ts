import { BillingSummarySchema } from "@alook/shared"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { cancelScheduledChange } from "@/lib/billing/service"

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const text = await req.text()
  if (text.trim()) {
    try {
      const body = JSON.parse(text)
      if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) return billingResponse({ error: "BILLING_REQUEST_INVALID" }, 400)
    } catch { return billingResponse({ error: "BILLING_REQUEST_INVALID" }, 400) }
  }
  try {
    const result = await cancelScheduledChange(getPrimaryDb(ctx.env.DB), billingClient(ctx.env), ctx.env, ctx.userId)
    return billingResponse(BillingSummarySchema.parse(result))
  } catch (error) {
    return billingFailure(error, "cancel-change")
  }
})
