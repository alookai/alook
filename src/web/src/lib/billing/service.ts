import { queries, type Database, type BillingSummary } from "@alook/shared"
import type Stripe from "stripe"
import { assertStripeMode, billingOrigin, BillingError, stripeId } from "./client"
import { getOffers, requireOffer } from "./catalog"
import { currentSubscription, reconcileBilling } from "./reconcile"

type BillingRow = NonNullable<Awaited<ReturnType<typeof queries.billing.getBilling>>>

async function requireBillingOwner(db: Database, userId: string, founderAcknowledged = false) {
  const effective = await queries.billing.getEffectivePlan(db, userId)
  if (effective.isFounder && !founderAcknowledged) throw new BillingError("BILLING_FOUNDER_PROTECTED", 403)
  const owner = await queries.user.getUserInternal(db, userId)
  if (!owner || owner.isBot || owner.deletedAt !== null) throw new BillingError("UNAUTHORIZED", 401)
  return effective
}

export async function getBillingSummary(db: Database, stripe: () => Stripe, env: Env, userId: string): Promise<BillingSummary> {
  const effective = await queries.billing.getEffectivePlan(db, userId)
  if (effective.isFounder) return { plan: effective.plan, isFounder: true, offers: await getOffers(db, stripe(), env), subscription: null }
  const [row, offers] = await Promise.all([queries.billing.getBilling(db, userId), getOffers(db, stripe(), env)])
  return { plan: effective.plan, isFounder: false, offers, subscription: row?.subscription ?? null }
}

async function sessionForAttempt(stripe: Stripe, env: Env, row: BillingRow) {
  const attempt = row.checkoutAttempt
  if (!attempt || !row.customerId) return null
  if (attempt.sessionId) {
    const session = await stripe.checkout.sessions.retrieve(attempt.sessionId)
    assertStripeMode(env, session)
    if (stripeId(session.customer) !== row.customerId || session.metadata?.alook_attempt_id !== attempt.id) {
      throw new BillingError("BILLING_CHECKOUT_MISMATCH", 503)
    }
    return session
  }
  for await (const session of stripe.checkout.sessions.list({ customer: row.customerId, limit: 100 })) {
    if (session.metadata?.alook_attempt_id !== attempt.id) continue
    assertStripeMode(env, session)
    return session
  }
  return null
}

export async function createCheckout(db: Database, stripe: Stripe, env: Env, userId: string, email: string, priceId: string, founderAcknowledged = false) {
  const effective = await requireBillingOwner(db, userId, founderAcknowledged)
  await requireOffer(db, stripe, env, priceId)
  for (let retry = 0; retry < 5; retry++) {
    let row = await queries.billing.ensureBilling(db, userId, founderAcknowledged)
    if (!row) throw new BillingError("BILLING_FOUNDER_PROTECTED", 403)
    if (row.customerId && await currentSubscription(stripe, env, row).then((sub) => sub && !["canceled", "incomplete_expired"].includes(sub.status))) {
      await reconcileBilling(db, stripe, env, userId)
      throw new BillingError("BILLING_SUBSCRIPTION_EXISTS")
    }
    if (!row.checkoutAttempt) {
      const reserved = await queries.billing.updateBilling(db, row, { checkoutAttempt: {
        id: crypto.randomUUID(), priceId, email, origin: billingOrigin(env),
        startedAt: Math.floor(Date.now() / 1000), sessionId: null,
        ...(founderAcknowledged ? { founderAcknowledged: true } : {}),
      } }, founderAcknowledged)
      if (!reserved) continue
      row = reserved
    }
    const attempt = row.checkoutAttempt!
    if (effective.isFounder && !attempt.founderAcknowledged) {
      throw new BillingError("BILLING_CHECKOUT_UNRESOLVED", 503)
    }
    let session = await sessionForAttempt(stripe, env, row)
    if (session?.status === "complete") {
      await reconcileBilling(db, stripe, env, userId)
      throw new BillingError("BILLING_SUBSCRIPTION_EXISTS")
    }
    if (session?.status === "expired") {
      if (!await queries.billing.updateBilling(db, row, { checkoutAttempt: null })) continue
      continue
    }
    if (attempt.priceId !== priceId) {
      if (!session || session.status !== "open") throw new BillingError("BILLING_CHECKOUT_IN_PROGRESS")
      try {
        session = await stripe.checkout.sessions.expire(session.id, {}, { idempotencyKey: `alook:expire:${attempt.id}` })
      } catch {
        session = await stripe.checkout.sessions.retrieve(session.id)
      }
      assertStripeMode(env, session)
      if (session.status === "complete") {
        await reconcileBilling(db, stripe, env, userId)
        throw new BillingError("BILLING_SUBSCRIPTION_EXISTS")
      }
      if (session.status !== "expired") throw new BillingError("BILLING_CHECKOUT_UNRESOLVED", 503)
      if (!await queries.billing.updateBilling(db, row, { checkoutAttempt: null })) continue
      continue
    }
    if (!session) {
      if (Date.now() / 1000 - attempt.startedAt >= 23 * 3600) throw new BillingError("BILLING_CHECKOUT_UNRESOLVED", 503)
      if (!row.customerId) {
        await requireBillingOwner(db, userId, founderAcknowledged)
        const customer = await stripe.customers.create({
          email: attempt.email,
          metadata: { alook_user_id: userId, alook_attempt_id: attempt.id },
        }, { idempotencyKey: `alook:customer:${attempt.id}` })
        assertStripeMode(env, customer)
        const saved = await queries.billing.updateBilling(db, row, { customerId: customer.id })
        if (!saved) continue
        row = saved
      }
      await requireBillingOwner(db, userId, founderAcknowledged)
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        managed_payments: { enabled: false },
        customer: row.customerId!,
        client_reference_id: userId,
        line_items: [{ price: attempt.priceId, quantity: 1 }],
        metadata: { alook_user_id: userId, alook_attempt_id: attempt.id },
        subscription_data: { metadata: { alook_user_id: userId, alook_attempt_id: attempt.id } },
        expires_at: attempt.startedAt + 24 * 3600 - 60,
        success_url: `${attempt.origin}/c/me/bots?billing=checkout`,
        cancel_url: `${attempt.origin}/c/me/bots?billing=cancel`,
      }, { idempotencyKey: `alook:checkout:${attempt.id}` })
      assertStripeMode(env, session)
    }
    if (!session.url || session.status !== "open") throw new BillingError("BILLING_CHECKOUT_UNRESOLVED", 503)
    if (row.checkoutAttempt?.sessionId !== session.id) {
      if (!await queries.billing.updateBilling(db, row, { checkoutAttempt: { ...attempt, sessionId: session.id } })) continue
    }
    await requireBillingOwner(db, userId, founderAcknowledged)
    return { url: session.url }
  }
  throw new BillingError("BILLING_RETRY_REQUIRED", 503)
}

export async function createPortal(db: Database, stripe: Stripe, env: Env, userId: string, priceId?: string) {
  await requireBillingOwner(db, userId)
  const row = await queries.billing.getBilling(db, userId)
  if (!row?.customerId) throw new BillingError("BILLING_SUBSCRIPTION_REQUIRED")
  const subscription = await currentSubscription(stripe, env, row)
  if (!subscription || ["canceled", "incomplete_expired"].includes(subscription.status)) throw new BillingError("BILLING_SUBSCRIPTION_REQUIRED")
  let configuration = env.STRIPE_PORTAL_CONFIGURATION_ID
  let flowData: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined
  if (priceId) {
    await requireOffer(db, stripe, env, priceId)
    const mapping = (await queries.billing.listPrices(db)).find((item) => item.priceId === priceId)
    configuration = mapping?.portalConfigurationId ?? undefined
    const item = subscription.items.data[0]
    if (!item || subscription.items.data.length !== 1 || item.quantity !== 1) throw new BillingError("BILLING_SUBSCRIPTION_UNSUPPORTED")
    flowData = {
      type: "subscription_update_confirm",
      subscription_update_confirm: { subscription: subscription.id, items: [{ id: item.id, price: priceId, quantity: 1 }] },
      after_completion: { type: "redirect", redirect: { return_url: `${billingOrigin(env)}/c/me/bots?billing=portal` } },
    }
  }
  if (!configuration) throw new BillingError("BILLING_UNAVAILABLE", 503)
  await requireBillingOwner(db, userId)
  const session = await stripe.billingPortal.sessions.create({
    customer: row.customerId, configuration, flow_data: flowData,
    return_url: `${billingOrigin(env)}/c/me/bots?billing=portal`,
  })
  return { url: session.url }
}

export async function cancelScheduledChange(db: Database, stripe: Stripe, env: Env, userId: string) {
  await requireBillingOwner(db, userId)
  const row = await queries.billing.getBilling(db, userId)
  if (row?.customerId) {
    const subscription = await currentSubscription(stripe, env, row)
    const schedule = typeof subscription?.schedule === "object" ? subscription.schedule : null
    const item = subscription?.items.data[0]
    const next = schedule?.status === "active" && schedule.current_phase
      ? schedule.phases.find((phase) => phase.start_date >= schedule.current_phase!.end_date)
      : undefined
    if (subscription && schedule && item && next?.items.length === 1 && stripeId(next.items[0].price) !== item.price.id) {
      if (stripeId(schedule.customer) !== row.customerId || stripeId(schedule.subscription) !== subscription.id) {
        throw new BillingError("BILLING_SUBSCRIPTION_MISMATCH", 503)
      }
      assertStripeMode(env, schedule)
      await requireBillingOwner(db, userId)
      try {
        await stripe.subscriptionSchedules.release(schedule.id, { preserve_cancel_date: true }, {
          idempotencyKey: `alook:release:${schedule.id}`,
        })
      } catch (error) {
        const fresh = await stripe.subscriptionSchedules.retrieve(schedule.id)
        if (!["released", "completed", "canceled"].includes(fresh.status)) throw error
      }
    }
    await reconcileBilling(db, stripe, env, userId)
  }
  return getBillingSummary(db, () => stripe, env, userId)
}
