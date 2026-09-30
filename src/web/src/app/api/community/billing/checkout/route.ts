import { BillingCheckoutRequestSchema, BillingRedirectResponseSchema, queries } from "@alook/shared"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { billingClient, billingFailure, billingResponse } from "@/lib/billing/client"
import { createCheckout } from "@/lib/billing/service"
import { readCheckoutAnalyticsConsent } from "@/lib/analytics-consent-server"

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const parsed = BillingCheckoutRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return billingResponse({ error: "BILLING_REQUEST_INVALID" }, 400)
  try {
    const db = getPrimaryDb(ctx.env.DB)
    const consent = await readCheckoutAnalyticsConsent(req.headers.get("cookie") ?? "", ctx.env.BETTER_AUTH_SECRET)
    const persistedConsent = consent.decision && consent.sourceVersion
      ? await queries.billing.recordAnalyticsConsent(db, ctx.userId, consent.decision, consent.sourceVersion)
      : null
    const analytics = consent.identity && persistedConsent?.decision === "granted"
      ? { ...consent.identity, consentRevision: persistedConsent.revision }
      : undefined
    const analyticsSkipReason = consent.decision === "granted" && persistedConsent?.decision === "denied"
      ? "stale_consent_proof" as const
      : undefined
    const result = await createCheckout(
      db,
      billingClient(ctx.env),
      ctx.env,
      ctx.userId,
      ctx.email,
      parsed.data.priceId,
      parsed.data.founderAcknowledged,
      analytics,
      analyticsSkipReason,
    )
    return billingResponse(BillingRedirectResponseSchema.parse(result))
  } catch (error) {
    return billingFailure(error, "checkout")
  }
})
