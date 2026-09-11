import { withEnv } from "@/lib/middleware/env"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { handleBillingWebhook } from "@/lib/billing/webhook"

export const POST = withEnv(async (req, ctx) => {
  try {
    await handleBillingWebhook(getPrimaryDb(ctx.env.DB), billingClient(ctx.env), ctx.env, await req.text(), req.headers.get("stripe-signature"))
    return billingResponse({ received: true })
  } catch (error) {
    return billingFailure(error, "webhook")
  }
})
