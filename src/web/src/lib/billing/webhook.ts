import { queries, type Database } from "@alook/shared"
import Stripe from "stripe"
import { assertStripeMode, BillingError, stripeId } from "./client"
import { reconcileBilling } from "./reconcile"

export async function handleBillingWebhook(db: Database, stripe: Stripe, env: Env, raw: string, signature: string | null) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new BillingError("BILLING_UNAVAILABLE", 503)
  if (!signature) throw new BillingError("BILLING_SIGNATURE_INVALID", 400)
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider())
  } catch {
    throw new BillingError("BILLING_SIGNATURE_INVALID", 400)
  }
  assertStripeMode(env, event)
  if (!event.type.startsWith("customer.subscription.") && !event.type.startsWith("invoice.")
    && !event.type.startsWith("checkout.session.") && !event.type.startsWith("subscription_schedule.")) return
  const object = event.data.object as unknown as { customer?: string | { id: string } | null }
  const customerId = stripeId(object.customer)
  if (!customerId) return
  let row = await queries.billing.getBillingByCustomer(db, customerId)
  if (!row) {
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) return
    assertStripeMode(env, customer)
    const userId = customer.metadata.alook_user_id
    if (!userId) return
    const candidate = await queries.billing.getBilling(db, userId)
    if (!candidate || candidate.customerId || !candidate.checkoutAttempt
      || candidate.checkoutAttempt.id !== customer.metadata.alook_attempt_id) return
    if ((await queries.billing.getEffectivePlan(db, userId)).isFounder && !candidate.checkoutAttempt.founderAcknowledged) return
    row = await queries.billing.updateBilling(db, candidate, { customerId })
    if (!row) throw new BillingError("BILLING_RETRY_REQUIRED", 503)
  }
  await reconcileBilling(db, stripe, env, row.userId)
}
