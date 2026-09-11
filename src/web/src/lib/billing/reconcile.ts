import { queries, type Database, type BillingSubscription, type ResolvedProductPlan } from "@alook/shared"
import type Stripe from "stripe"
import { assertStripeMode, BillingError, stripeId } from "./client"
import { getCatalog } from "./catalog"
import { pushBotEventToMachine } from "@/lib/community/bot-push"
import { fanOutPresenceUpdate } from "@/lib/community/fanout"
import { forceCloseCommunityMachinesByDoNames } from "@/lib/community/machine-disconnect"
import { broadcastToUser } from "@/lib/broadcast"

type Catalog = Awaited<ReturnType<typeof getCatalog>>
type BillingRow = NonNullable<Awaited<ReturnType<typeof queries.billing.getBilling>>>

const terminal = new Set(["canceled", "unpaid", "incomplete_expired"])

export async function currentSubscription(stripe: Stripe, env: Env, row: BillingRow) {
  if (!row.customerId) return null
  const customer = await stripe.customers.retrieve(row.customerId)
  if (customer.deleted) {
    if (!row.subscriptionId) return null
    const canceled = await stripe.subscriptions.retrieve(row.subscriptionId, { expand: ["latest_invoice", "schedule"] })
    assertStripeMode(env, canceled)
    if (stripeId(canceled.customer) !== row.customerId || canceled.metadata.alook_user_id !== row.userId
      || !terminal.has(canceled.status)) throw new BillingError("BILLING_CUSTOMER_UNAVAILABLE", 503)
    return canceled
  }
  assertStripeMode(env, customer)
  if (customer.metadata.alook_user_id !== row.userId) throw new BillingError("BILLING_CUSTOMER_MISMATCH", 503)
  const candidates: Stripe.Subscription[] = []
  for await (const subscription of stripe.subscriptions.list({ customer: row.customerId, status: "all", limit: 100 })) {
    if (subscription.metadata.alook_user_id !== row.userId || ["canceled", "incomplete_expired"].includes(subscription.status)) continue
    assertStripeMode(env, subscription)
    candidates.push(subscription)
    if (candidates.length > 1) throw new BillingError("BILLING_MULTIPLE_SUBSCRIPTIONS", 503)
  }
  const id = candidates[0]?.id ?? row.subscriptionId
  if (!id) return null
  const subscription = await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice", "schedule"] })
  assertStripeMode(env, subscription)
  if (stripeId(subscription.customer) !== row.customerId || subscription.metadata.alook_user_id !== row.userId) {
    throw new BillingError("BILLING_SUBSCRIPTION_MISMATCH", 503)
  }
  return subscription
}

function paidLineFor(subscription: Stripe.Subscription, paidInvoice: Stripe.Invoice | null, catalog: Catalog) {
  const invoiceLines = paidInvoice?.status === "paid" ? paidInvoice.lines.data.filter((line) =>
    stripeId(line.parent?.subscription_item_details?.subscription ?? line.subscription) === subscription.id && line.amount >= 0,
  ) : []
  return invoiceLines.find((line) => stripeId(line.pricing?.price_details?.price) === subscription.items.data[0]?.price.id)
    ?? invoiceLines.find((line) => catalog.some((entry) => entry.priceId === stripeId(line.pricing?.price_details?.price)))
}

export function projectSubscription(
  subscription: Stripe.Subscription | null,
  paidInvoice: Stripe.Invoice | null,
  catalog: Catalog,
  free: ResolvedProductPlan,
  previousPaidPrice: Stripe.Price | null = null,
): { plan: ResolvedProductPlan; subscription: BillingSubscription | null } {
  if (!subscription || ["canceled", "incomplete_expired"].includes(subscription.status)) return { plan: free, subscription: null }
  const item = subscription.items.data[0]
  if (!item || subscription.items.data.length !== 1 || item.quantity !== 1) {
    throw new BillingError("BILLING_SUBSCRIPTION_UNSUPPORTED", 503)
  }
  const current = catalog.find((entry) => entry.priceId === item.price.id)
  if (!current) throw new BillingError("BILLING_PRICE_UNAVAILABLE", 503)
  const asPlan = (entry: Catalog[number]) => ({ id: entry.planId, displayName: entry.displayName })
  const latest = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null
  const paidLine = paidLineFor(subscription, paidInvoice, catalog)
  const paid = catalog.find((entry) => entry.priceId === stripeId(paidLine?.pricing?.price_details?.price))
  let plan = free
  if (!terminal.has(subscription.status) && ["active", "past_due"].includes(subscription.status) && paid) {
    plan = asPlan(paid)
    const cycleDowngrade = latest?.billing_reason === "subscription_cycle" && !subscription.pending_update
      && previousPaidPrice?.id === paid.priceId && previousPaidPrice.currency === item.price.currency
      && previousPaidPrice.recurring?.interval === item.price.recurring?.interval
      && previousPaidPrice.recurring?.interval_count === item.price.recurring?.interval_count
      && previousPaidPrice.unit_amount !== null && item.price.unit_amount !== null
      && item.price.unit_amount < previousPaidPrice.unit_amount
    if (paid.priceId === current.priceId || cycleDowngrade) {
      plan = asPlan(current)
    }
  }
  const schedule = typeof subscription.schedule === "object" ? subscription.schedule : null
  const next = schedule?.status === "active" && schedule.current_phase
    ? schedule.phases.find((phase) => phase.start_date >= schedule.current_phase!.end_date)
    : undefined
  const nextMapping = next?.items.length === 1 ? catalog.find((entry) => entry.priceId === stripeId(next.items[0].price)) : undefined
  return {
    plan,
    subscription: {
      plan: asPlan(current),
      status: subscription.status,
      currentPeriodEnd: item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
      cancelAt: subscription.cancel_at != null ? new Date(subscription.cancel_at * 1000).toISOString()
        : subscription.cancel_at_period_end && item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
      scheduledChange: next && nextMapping && nextMapping.planId !== current.planId && (!subscription.cancel_at || subscription.cancel_at > next.start_date)
        ? { plan: asPlan(nextMapping), effectiveAt: new Date(next.start_date * 1000).toISOString() }
        : null,
    },
  }
}

async function paidInvoiceFor(stripe: Stripe, subscription: Stripe.Subscription) {
  const latest = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null
  if (latest?.status === "paid") return latest
  const invoices = await stripe.invoices.list({ subscription: subscription.id, status: "paid", limit: 1 })
  return invoices.data[0] ?? null
}

async function acknowledgedFounderSession(stripe: Stripe, env: Env, row: BillingRow, subscription: Stripe.Subscription) {
  const attempt = row.checkoutAttempt!
  let session: Stripe.Checkout.Session | null = null
  if (attempt.sessionId) {
    session = await stripe.checkout.sessions.retrieve(attempt.sessionId)
  } else {
    for await (const candidate of stripe.checkout.sessions.list({ customer: row.customerId!, limit: 100 })) {
      if (candidate.metadata?.alook_attempt_id !== attempt.id) continue
      if (session) throw new BillingError("BILLING_CHECKOUT_MISMATCH", 503)
      session = candidate
    }
  }
  if (!session) return false
  assertStripeMode(env, session)
  return session.status === "complete" && session.payment_status === "paid" && session.mode === "subscription"
    && stripeId(session.customer) === row.customerId && stripeId(session.subscription) === subscription.id
    && session.client_reference_id === row.userId && session.metadata?.alook_user_id === row.userId
    && session.metadata?.alook_attempt_id === attempt.id
}

export async function notifyDeactivated(env: Env, db: Database, ownerId: string, ids: string[]) {
  for (const id of ids) {
    try {
      const bot = await queries.communityBot.getBotOwnedBy(db, id, ownerId)
      if (!bot || bot.isActive) continue
      if (bot.machineId) await pushBotEventToMachine(env, bot.machineId, { type: "bot:removed", botId: id })
      const current = await queries.communityBot.getBotOwnedBy(db, id, ownerId)
      if (current && !current.isActive) await fanOutPresenceUpdate(id, false, ownerId)
    } catch {
      console.warn("billing_post_commit_notification_failed", { botId: id })
    }
  }
}

export async function notifyDisconnectedMachines(env: Env, db: Database, machines: Array<{ machineId: string; userId: string; doName: string | null }>) {
  await forceCloseCommunityMachinesByDoNames(env, [...new Set(machines.flatMap((machine) => machine.doName ? [machine.doName] : []))]);
  const unique = new Map(machines.map((machine) => [machine.machineId, machine]));
  for (const { machineId, userId } of unique.values()) {
    try {
      const machine = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId);
      if (!machine || machine.status !== "offline") continue;
      await broadcastToUser(userId, { type: "community:machine.status", machineId, status: "offline", lastSeenAt: machine.lastSeenAt ?? new Date().toISOString() });
      const bots = await queries.communityBot.listBotsBoundToMachine(db, machineId, userId);
      for (const bot of bots) {
        const current = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId);
        if (current?.status !== "offline") break;
        await fanOutPresenceUpdate(bot.id, false, userId);
      }
    } catch {
      console.warn("billing_post_commit_machine_notification_failed", { machineId });
    }
  }
}

export async function reconcileBilling(db: Database, stripe: Stripe, env: Env, userId: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await queries.billing.getBilling(db, userId)
    const effective = await queries.billing.getEffectivePlan(db, userId)
    if (!row || (effective.isFounder && !row.checkoutAttempt?.founderAcknowledged)) return
    const owner = await queries.user.getUserInternal(db, userId)
    if (!owner || owner.deletedAt !== null || owner.isBot) return
    const subscription = await currentSubscription(stripe, env, row)
    if (effective.isFounder && (!subscription || !["active", "past_due"].includes(subscription.status)
      || subscription.pending_update || subscription.metadata.alook_attempt_id !== row.checkoutAttempt!.id
      || subscription.items.data[0]?.price.id !== row.checkoutAttempt!.priceId)) return
    const [catalog, free, paidInvoice] = await Promise.all([
      getCatalog(db), queries.billing.getDefaultPlan(db),
      subscription ? paidInvoiceFor(stripe, subscription) : Promise.resolve(null),
    ])
    const previousPriceId = subscription ? stripeId(paidLineFor(subscription, paidInvoice, catalog)?.pricing?.price_details?.price) : null
    const latest = typeof subscription?.latest_invoice === "object" ? subscription.latest_invoice : null
    const previousPaidPrice = previousPriceId && previousPriceId !== subscription?.items.data[0]?.price.id && latest?.billing_reason === "subscription_cycle"
      ? await stripe.prices.retrieve(previousPriceId) : null
    if (previousPaidPrice) assertStripeMode(env, previousPaidPrice)
    const projection = projectSubscription(subscription, paidInvoice, catalog, free, previousPaidPrice)
    if (effective.isFounder && (paidInvoice?.status !== "paid"
      || stripeId(paidLineFor(subscription!, paidInvoice, catalog)?.pricing?.price_details?.price) !== row.checkoutAttempt!.priceId
      || projection.plan.id !== catalog.find((entry) => entry.priceId === row.checkoutAttempt!.priceId)?.planId
      || !await acknowledgedFounderSession(stripe, env, row, subscription!))) return
    const patch = {
      subscriptionId: subscription?.id ?? null,
      subscription: projection.subscription,
      ...(subscription && row.checkoutAttempt && subscription.metadata.alook_attempt_id === row.checkoutAttempt.id
        ? { checkoutAttempt: null } : {}),
    }
    const result = effective.isFounder
      ? await queries.billing.applyBillingPlan(db, row, patch, projection.plan.id, row.checkoutAttempt!.id)
      : await queries.billing.applyBillingPlan(db, row, patch, projection.plan.id)
    if (result.applied) {
      await notifyDeactivated(env, db, userId, result.deactivatedBotIds)
      await notifyDisconnectedMachines(env, db, result.disconnectedMachines ?? [])
      return
    }
  }
  throw new BillingError("BILLING_RETRY_REQUIRED", 503)
}
