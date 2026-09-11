vi.mock("@/lib/community/machine-disconnect", () => ({ forceCloseCommunityMachinesByDoNames: vi.fn(async () => {}) }))
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn(async () => {}) }))
import { describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
vi.mock("@/lib/community/bot-push", () => ({ pushBotEventToMachine: vi.fn() }))
vi.mock("@/lib/community/fanout", () => ({ fanOutPresenceUpdate: vi.fn() }))
import { projectSubscription } from "./reconcile"

const catalog = [
  { priceId: "price_studio", planId: "studio", displayName: "Studio", botLimit: 10, machineLimit: 5, sortOrder: 1, portalConfigurationId: "bpc_studio" },
  { priceId: "price_house", planId: "house", displayName: "House", botLimit: 40, machineLimit: 10, sortOrder: 2, portalConfigurationId: "bpc_house" },
]
const free = { id: "free", displayName: "Free" }
function invoice(price: string, status = "paid", reason = "subscription_create") {
  return { id: "in_1", status, billing_reason: reason,
    lines: { data: [{ parent: { subscription_item_details: { subscription: "sub_1" } }, amount: 2000, pricing: { price_details: { price } } }] },
  } as unknown as Stripe.Invoice
}
function subscription(price = "price_studio", status = "active", latest: Stripe.Invoice | null = invoice(price)) {
  return { id: "sub_1", status, cancel_at_period_end: false, pending_update: null,
    latest_invoice: latest, schedule: null,
    items: { data: [{ id: "si_1", quantity: 1, price: { id: price, unit_amount: price === "price_house" ? 4000 : 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } }, current_period_end: 1791604427 }] },
  } as unknown as Stripe.Subscription
}

describe("payment-backed subscription projection", () => {
  it("does not grant an active initial subscription without a paid invoice", () => {
    expect(projectSubscription(subscription("price_house", "active", invoice("price_house", "open")), null, catalog, free).plan).toEqual(free)
  })
  it("grants the paid plan and carries its confirmed period", () => {
    expect(projectSubscription(subscription(), invoice("price_studio"), catalog, free)).toMatchObject({
      plan: { id: "studio" }, subscription: { plan: { id: "studio" }, currentPeriodEnd: new Date(1791604427 * 1000).toISOString() },
    })
  })
  it("retains the paid tier for an unpaid upgrade even if Stripe's current item changed", () => {
    const sub = subscription("price_house", "active", invoice("price_house", "open", "subscription_update"))
    expect(projectSubscription(sub, invoice("price_studio"), catalog, free).plan.id).toBe("studio")
  })
  it("does not interpret a requested 3DS pending item as paid", () => {
    const sub = subscription("price_studio", "active", invoice("price_house", "open", "subscription_update"))
    sub.pending_update = { subscription_items: [{ price: "price_house" }], expires_at: 1791000000 } as Stripe.Subscription.PendingUpdate
    expect(projectSubscription(sub, invoice("price_studio"), catalog, free).plan.id).toBe("studio")
  })
  it("applies a paid proration and disregards its negative old-tier credit line", () => {
    const paid = invoice("price_house", "paid", "subscription_update")
    paid.lines.data.unshift({ parent: { subscription_item_details: { subscription: "sub_1" } }, amount: -2000, pricing: { price_details: { price: "price_studio" } } } as Stripe.InvoiceLineItem)
    expect(projectSubscription(subscription("price_house", "active", paid), paid, catalog, free).plan.id).toBe("house")
  })
  it("keeps a paid tier during renewal retries", () => {
    const sub = subscription("price_house", "past_due", invoice("price_house", "open", "subscription_cycle"))
    expect(projectSubscription(sub, invoice("price_house"), catalog, free).plan.id).toBe("house")
  })
  it("does not grant initial access merely because a cycle invoice exists", () => {
    const sub = subscription("price_house", "past_due", invoice("price_house", "open", "subscription_cycle"))
    expect(projectSubscription(sub, null, catalog, free).plan).toEqual(free)
  })
  it("projects a scheduled downgrade without changing current entitlement", () => {
    const sub = subscription("price_house")
    sub.schedule = { status: "active", current_phase: { start_date: 1, end_date: 1791604427 }, phases: [
      { start_date: 1, end_date: 1791604427, items: [{ price: "price_house" }] },
      { start_date: 1791604427, items: [{ price: "price_studio" }] },
    ] } as Stripe.SubscriptionSchedule
    expect(projectSubscription(sub, invoice("price_house"), catalog, free)).toMatchObject({
      plan: { id: "house" }, subscription: { scheduledChange: { plan: { id: "studio" }, effectiveAt: new Date(1791604427 * 1000).toISOString() } },
    })
  })
  it("uses the new cycle tier when a scheduled downgrade reaches renewal retries", () => {
    const sub = subscription("price_studio", "past_due", invoice("price_studio", "open", "subscription_cycle"))
    expect(projectSubscription(sub, invoice("price_house"), catalog, free, { id: "price_house", unit_amount: 4000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } as Stripe.Price).plan.id).toBe("studio")
  })
  it("does not grant a higher tier from an unpaid cycle invoice", () => {
    const sub = subscription("price_house", "past_due", invoice("price_house", "open", "subscription_cycle"))
    expect(projectSubscription(sub, invoice("price_studio"), catalog, free, { id: "price_studio", unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } as Stripe.Price).plan.id).toBe("studio")
  })
  it.each(["canceled", "unpaid", "incomplete_expired"])("returns terminal %s to Free", (status) => {
    expect(projectSubscription(subscription("price_house", status), invoice("price_house"), catalog, free).plan).toEqual(free)
  })
  it("keeps period-end cancellation on the paid tier until termination", () => {
    const sub = subscription("price_house")
    sub.cancel_at_period_end = true
    expect(projectSubscription(sub, invoice("price_house"), catalog, free)).toMatchObject({ plan: { id: "house" }, subscription: { cancelAt: new Date(1791604427 * 1000).toISOString() } })
  })
  it("projects explicit period-end cancel_at even when Stripe clears cancel_at_period_end", () => {
    const sub = subscription("price_house")
    sub.cancel_at = 1791604427
    expect(projectSubscription(sub, invoice("price_house"), catalog, free)).toMatchObject({
      plan: { id: "house" }, subscription: { cancelAt: new Date(1791604427 * 1000).toISOString(), currentPeriodEnd: new Date(sub.cancel_at * 1000).toISOString() },
    })
  })
  it("rejects an unmapped live price rather than silently granting or revoking", () => {
    expect(() => projectSubscription(subscription("unknown"), invoice("unknown"), catalog, free)).toThrow("BILLING_PRICE_UNAVAILABLE")
  })
  it("never accepts another subscription's paid invoice lines", () => {
    const paid = invoice("price_house")
    paid.lines.data[0].parent!.subscription_item_details!.subscription = "sub_other"
    expect(projectSubscription(subscription("price_house"), paid, catalog, free).plan).toEqual(free)
  })
})
