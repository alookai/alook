import { BillingCheckoutRequestSchema, BillingRedirectResponseSchema } from "@alook/shared"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { createCheckout } from "@/lib/billing/service"

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const parsed = BillingCheckoutRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return billingResponse({ error: "BILLING_REQUEST_INVALID" }, 400)
  try {
    const result = await createCheckout(getPrimaryDb(ctx.env.DB), billingClient(ctx.env), ctx.env, ctx.userId, ctx.email, parsed.data.priceId, parsed.data.founderAcknowledged)
    return billingResponse(BillingRedirectResponseSchema.parse(result))
  } catch (error) {
    return billingFailure(error, "checkout")
  }
})
