import { BillingPortalRequestSchema, BillingRedirectResponseSchema } from "@alook/shared"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { createPortal } from "@/lib/billing/service"

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const text = await req.text()
  let body: unknown = {}
  try { if (text.trim()) body = JSON.parse(text) } catch { body = null }
  const parsed = BillingPortalRequestSchema.safeParse(body)
  if (!parsed.success) return billingResponse({ error: "BILLING_REQUEST_INVALID" }, 400)
  try {
    const result = await createPortal(getPrimaryDb(ctx.env.DB), billingClient(ctx.env), ctx.env, ctx.userId, parsed.data.priceId)
    return billingResponse(BillingRedirectResponseSchema.parse(result))
  } catch (error) {
    return billingFailure(error, "portal")
  }
})
