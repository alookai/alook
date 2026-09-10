import { beforeEach, describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
import type { Database } from "@alook/shared"
const mocked = vi.hoisted(() => ({ getBilling: vi.fn(), getEffectivePlan: vi.fn(), getDefaultPlan: vi.fn(), applyBillingPlan: vi.fn(), getUserInternal: vi.fn(), getBotOwnedBy: vi.fn(), getCatalog: vi.fn(), push: vi.fn(), presence: vi.fn() }))
vi.mock("@alook/shared", () => ({ queries: { billing: mocked, user: mocked, communityBot: mocked } }))
vi.mock("./catalog", () => ({ getCatalog: mocked.getCatalog }))
vi.mock("@/lib/community/bot-push", () => ({ pushBotEventToMachine: mocked.push }))
vi.mock("@/lib/community/fanout", () => ({ fanOutPresenceUpdate: mocked.presence }))
import { currentSubscription, notifyDeactivated, reconcileBilling } from "./reconcile"

const db = {} as Database
const env = { STRIPE_SECRET_KEY: "sk_test_fixture" } as Env
const row = { userId: "owner", customerId: "cus_1", subscriptionId: "sub_old", subscription: null, checkoutAttempt: null, revision: 1, applyToken: null, updatedAt: "2026-09-10" }
function sub(id: string, price: string) {
  return { id, customer: "cus_1", livemode: false, metadata: { alook_user_id: "owner" }, status: "active", cancel_at: null, cancel_at_period_end: false,
    items: { data: [{ id: "si_1", quantity: 1, price: { id: price }, current_period_end: 1791604427 }] },
    latest_invoice: { status: "paid", lines: { data: [{ amount: 2000, parent: { subscription_item_details: { subscription: id } }, pricing: { price_details: { price } } }] } },
  }
}
let stripe: Stripe
let retrieve: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetAllMocks()
  mocked.getBilling.mockResolvedValue(row)
  mocked.getEffectivePlan.mockResolvedValue({ isFounder: false })
  mocked.getUserInternal.mockResolvedValue({ isBot: false, deletedAt: null })
  mocked.getDefaultPlan.mockResolvedValue({ id: "free", displayName: "Free" })
  mocked.getCatalog.mockResolvedValue([{ priceId: "studio", planId: "studio", displayName: "Studio" }, { priceId: "house", planId: "house", displayName: "House" }])
  mocked.applyBillingPlan.mockResolvedValue({ applied: true, deactivatedBotIds: [] })
  retrieve = vi.fn(async () => sub("sub_new", "house"))
  stripe = { customers: { retrieve: vi.fn(async () => ({ livemode: false, metadata: { alook_user_id: "owner" } })) }, subscriptions: {
    list: vi.fn(() => ({ async *[Symbol.asyncIterator]() { yield sub("sub_new", "house") } })), retrieve,
  } } as unknown as Stripe
})

describe("reconciliation freshness and post-commit effects", () => {
  function confirmedFounder() {
    const attempt = { id: "attempt-founder", priceId: "studio", founderAcknowledged: true, sessionId: "cs-founder" }
    mocked.getBilling.mockResolvedValue({ ...row, checkoutAttempt: attempt })
    mocked.getEffectivePlan.mockResolvedValue({ isFounder: true })
    const subscription = { ...sub("sub_new", "studio"), metadata: { alook_user_id: "owner", alook_attempt_id: attempt.id } }
    retrieve.mockResolvedValue(subscription)
    const session = { id: "cs-founder", livemode: false, status: "complete", payment_status: "paid", mode: "subscription",
      customer: "cus_1", subscription: "sub_new", client_reference_id: "owner", metadata: subscription.metadata }
    stripe.checkout = { sessions: { retrieve: vi.fn(async () => session) } } as unknown as Stripe["checkout"]
    return { attempt, subscription, session }
  }

  it("only converts the current acknowledged paid Founder purchase", async () => {
    confirmedFounder()
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).toHaveBeenCalledWith(db, expect.objectContaining({ checkoutAttempt: { id: "attempt-founder", priceId: "studio", founderAcknowledged: true, sessionId: "cs-founder" } }), expect.objectContaining({ checkoutAttempt: null, subscriptionId: "sub_new" }), "studio", "attempt-founder")
  })

  it.each([
    { status: "open" }, { payment_status: "unpaid" }, { customer: "foreign" }, { subscription: "sub_old" },
    { client_reference_id: "other" }, { metadata: { alook_user_id: "owner", alook_attempt_id: "old" } },
  ])("keeps Founder for an unpaid or mismatched Checkout: %j", async (change) => {
    const { session } = confirmedFounder()
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ ...session, ...change } as Stripe.Response<Stripe.Checkout.Session>)
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })

  it.each(["canceled", "unpaid", "incomplete", "incomplete_expired"])("keeps Founder for subscription status %s", async (status) => {
    const { subscription } = confirmedFounder()
    retrieve.mockResolvedValue({ ...subscription, status })
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })

  it("does not use a paid unrelated subscription or a pending update as Founder consent", async () => {
    const { subscription } = confirmedFounder()
    retrieve.mockResolvedValue({ ...subscription, metadata: { alook_user_id: "owner", alook_attempt_id: "old" } })
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
    retrieve.mockResolvedValue({ ...subscription, pending_update: {} })
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })

  it("recovers a paid Founder session after the session-id write was lost", async () => {
    const { attempt, session } = confirmedFounder()
    mocked.getBilling.mockResolvedValue({ ...row, checkoutAttempt: { ...attempt, sessionId: null } })
    stripe.checkout.sessions.list = vi.fn(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...session, id: "unrelated", metadata: { alook_attempt_id: "old" } }
      yield session
    } })) as unknown as typeof stripe.checkout.sessions.list
    await reconcileBilling(db, stripe, env, "owner")
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
    expect(mocked.applyBillingPlan).toHaveBeenCalledWith(db, expect.anything(), expect.objectContaining({ checkoutAttempt: null }), "studio", attempt.id)
  })

  it("keeps ambiguous lost-session recovery retryable without Founder conversion", async () => {
    const { attempt, session } = confirmedFounder()
    mocked.getBilling.mockResolvedValue({ ...row, checkoutAttempt: { ...attempt, sessionId: null } })
    stripe.checkout.sessions.list = vi.fn(() => ({ async *[Symbol.asyncIterator]() {
      yield session
      yield { ...session, id: "another-session" }
    } })) as unknown as typeof stripe.checkout.sessions.list
    await expect(reconcileBilling(db, stripe, env, "owner")).rejects.toMatchObject({ code: "BILLING_CHECKOUT_MISMATCH", status: 503 })
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })

  it("does not carry consent across a losing revision into an unacknowledged attempt", async () => {
    const { attempt } = confirmedFounder()
    mocked.getBilling.mockResolvedValueOnce({ ...row, checkoutAttempt: attempt })
      .mockResolvedValue({ ...row, revision: 2, checkoutAttempt: { ...attempt, id: "replacement", founderAcknowledged: false } })
    mocked.applyBillingPlan.mockResolvedValueOnce({ applied: false, deactivatedBotIds: [] })
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).toHaveBeenCalledOnce()
    expect(retrieve).toHaveBeenCalledOnce()
    expect(mocked.push).not.toHaveBeenCalled()
    expect(mocked.presence).not.toHaveBeenCalled()
  })

  it.each(["current-price", "paid-price", "invoice-subscription"])("preserves Founder when %s does not match the authorized purchase", async (mismatch) => {
    const { subscription } = confirmedFounder()
    if (mismatch === "current-price") subscription.items.data[0].price.id = "house"
    if (mismatch === "paid-price") subscription.latest_invoice.lines.data[0].pricing.price_details.price = "house"
    if (mismatch === "invoice-subscription") subscription.latest_invoice.lines.data[0].parent.subscription_item_details.subscription = "foreign"
    retrieve.mockResolvedValue(subscription)
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })

  it("reads primary revision before fetching Stripe and refetches everything after losing a batch", async () => {
    mocked.applyBillingPlan.mockResolvedValueOnce({ applied: false, deactivatedBotIds: [] })
    retrieve.mockResolvedValueOnce(sub("sub_new", "studio"))
    await reconcileBilling(db, stripe, env, "owner")
    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(mocked.getBilling).toHaveBeenCalledTimes(2)
    expect(mocked.applyBillingPlan.mock.calls.map((call) => call[3])).toEqual(["studio", "house"])
    expect(mocked.getBilling.mock.invocationCallOrder[0]).toBeLessThan(retrieve.mock.invocationCallOrder[0])
    expect(mocked.getBilling.mock.invocationCallOrder[1]).toBeLessThan(retrieve.mock.invocationCallOrder[1])
  })
  it("keeps a persistent conflict retryable after bounded fresh attempts", async () => {
    mocked.applyBillingPlan.mockResolvedValue({ applied: false, deactivatedBotIds: [] })
    await expect(reconcileBilling(db, stripe, env, "owner")).rejects.toMatchObject({ code: "BILLING_RETRY_REQUIRED", status: 503 })
    expect(retrieve).toHaveBeenCalledTimes(4)
  })
  it("selects the current managed subscription instead of the stored old canceled identity", async () => {
    expect((await currentSubscription(stripe, env, row))?.id).toBe("sub_new")
    expect(retrieve).toHaveBeenCalledWith("sub_new", expect.anything())
  })
  it("rejects foreign customer metadata before looking at subscriptions", async () => {
    vi.mocked(stripe.customers.retrieve).mockResolvedValue({ livemode: false, metadata: { alook_user_id: "other" } } as Stripe.Response<Stripe.Customer>)
    await expect(currentSubscription(stripe, env, row)).rejects.toMatchObject({ code: "BILLING_CUSTOMER_MISMATCH" })
    expect(retrieve).not.toHaveBeenCalled()
  })
  it("can revoke the canceled subscription after Stripe deletes its customer", async () => {
    vi.mocked(stripe.customers.retrieve).mockResolvedValue({ id: "cus_1", deleted: true } as Stripe.Response<Stripe.DeletedCustomer>)
    retrieve.mockResolvedValue({ ...sub("sub_old", "house"), status: "canceled" })
    await reconcileBilling(db, stripe, env, "owner")
    expect(mocked.applyBillingPlan).toHaveBeenCalledWith(db, row, expect.objectContaining({ subscription: null }), "free")
  })
  it("does not call Stripe or apply a projection for a Founder", async () => {
    mocked.getEffectivePlan.mockResolvedValue({ isFounder: true })
    await reconcileBilling(db, stripe, env, "owner")
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(mocked.applyBillingPlan).not.toHaveBeenCalled()
  })
  it("does not send an old removal after a bot has been reactivated", async () => {
    mocked.getBotOwnedBy.mockResolvedValue({ isActive: true, machineId: "m1" })
    await notifyDeactivated(env, db, "owner", ["bot1"])
    expect(mocked.push).not.toHaveBeenCalled()
    expect(mocked.presence).not.toHaveBeenCalled()
  })
  it("checks current state again before forcing Offline", async () => {
    mocked.getBotOwnedBy.mockResolvedValueOnce({ isActive: false, machineId: "m1" }).mockResolvedValueOnce({ isActive: true, machineId: "m1" })
    await notifyDeactivated(env, db, "owner", ["bot1"])
    expect(mocked.push).toHaveBeenCalledOnce()
    expect(mocked.presence).not.toHaveBeenCalled()
  })
  it("does not turn best-effort notification failure into a failed durable commit", async () => {
    mocked.applyBillingPlan.mockResolvedValue({ applied: true, deactivatedBotIds: ["bot1"] })
    mocked.getBotOwnedBy.mockResolvedValue({ isActive: false, machineId: "m1" })
    mocked.push.mockRejectedValue(new Error("offline"))
    await expect(reconcileBilling(db, stripe, env, "owner")).resolves.toBeUndefined()
    expect(mocked.applyBillingPlan).toHaveBeenCalledOnce()
  })
})
