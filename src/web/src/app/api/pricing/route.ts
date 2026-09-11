import { withEnv } from "@/lib/middleware/env"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { getPublicPricing } from "@/lib/billing/catalog"

export const GET = withEnv(async (_req, ctx) => {
  try {
    return billingResponse(await getPublicPricing(getPrimaryDb(ctx.env.DB), billingClient(ctx.env), ctx.env))
  } catch (error) {
    return billingFailure(error, "public_pricing")
  }
})
