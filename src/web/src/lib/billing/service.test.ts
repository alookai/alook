import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"
import type Stripe from "stripe"

const mocked = vi.hoisted(() => ({
  getEffectivePlan: vi.fn(), getUserInternal: vi.fn(), ensureBilling: vi.fn(), getBilling: vi.fn(), updateBilling: vi.fn(), listPrices: vi.fn(),
  requireOffer: vi.fn(), getOffers: vi.fn(), currentSubscription: vi.fn(), reconcileBilling: vi.fn(),
}))
vi.mock("@alook/shared", () => ({ queries: { billing: mocked, user: mocked } }))
vi.mock("./catalog", () => ({ requireOffer: mocked.requireOffer, getOffers: mocked.getOffers }))
vi.mock("./reconcile", () => ({ currentSubscription: mocked.currentSubscription, reconcileBilling: mocked.reconcileBilling }))
import { createCheckout, createPortal, getBillingSummary, cancelScheduledChange } from "./service"
import { BillingError } from "./client"

type Row = {
  userId: string; customerId: string | null; subscriptionId: string | null; subscription: null; revision: number;
  checkoutAttempt: null | { id: string; priceId: string; email: string; origin: string; startedAt: number; sessionId: string | null; founderAcknowledged?: boolean };
}
let row: Row
let founder: boolean
let sessions: Array<Record<string, unknown>>
let customers: Map<string, { id: string; livemode: boolean }>
let stripe: Stripe
let sessionCreates: ReturnType<typeof vi.fn>
let customerCreates: ReturnType<typeof vi.fn>
const db = {} as Database
const env = { STRIPE_SECRET_KEY: "sk_test_fake", BETTER_AUTH_URL: "http://localhost:3000", STRIPE_PORTAL_CONFIGURATION_ID: "bpc_manage" } as Env

beforeEach(() => {
  vi.resetAllMocks()
  founder = false
  row = { userId: "owner", customerId: null, subscriptionId: null, subscription: null, revision: 0, checkoutAttempt: null }
  sessions = []
  customers = new Map()
  mocked.getEffectivePlan.mockImplementation(async () => ({ plan: { id: founder ? "house" : "free", displayName: founder ? "House" : "Free" }, isFounder: founder }))
  mocked.getUserInternal.mockResolvedValue({ id: "owner", email: "qa@example.test", isBot: false, deletedAt: null })
  mocked.getBilling.mockImplementation(async () => structuredClone(row))
  mocked.ensureBilling.mockImplementation(async () => structuredClone(row))
  mocked.updateBilling.mockImplementation(async (_db, current: Row, patch: Partial<Row>, acknowledged = false) => {
    if ((founder && !acknowledged && !current.checkoutAttempt?.founderAcknowledged) || current.revision !== row.revision) return null
    row = { ...row, ...patch, revision: row.revision + 1 }
    return structuredClone(row)
  })
  mocked.requireOffer.mockImplementation(async (_db, _stripe, _env, priceId) => ({ priceId }))
  mocked.getOffers.mockResolvedValue([])
  mocked.currentSubscription.mockResolvedValue(null)
  mocked.listPrices.mockResolvedValue([{ priceId: "house", portalConfigurationId: "bpc_house" }])
  customerCreates = vi.fn(async (_params, options) => {
    if (!customers.has(options.idempotencyKey)) customers.set(options.idempotencyKey, { id: `cus_${customers.size}`, livemode: false })
    return customers.get(options.idempotencyKey)
  })
  sessionCreates = vi.fn(async (params) => {
    const existing = sessions.find((session) => (session.metadata as { alook_attempt_id: string }).alook_attempt_id === params.metadata.alook_attempt_id)
    if (existing) return existing
    const session = { id: `cs_${sessions.length}`, status: "open", url: "https://checkout.stripe.com/test", livemode: false, ...params }
    sessions.push(session)
    return session
  })
  stripe = {
    customers: { create: customerCreates },
    checkout: { sessions: {
      create: sessionCreates,
      retrieve: vi.fn(async (id) => sessions.find((s) => s.id === id)),
      expire: vi.fn(async (id) => { const session = sessions.find((s) => s.id === id)!; session.status = "expired"; return session }),
      list: vi.fn(() => ({ async *[Symbol.asyncIterator]() { yield* sessions } })),
    } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/test" })) } },
  } as unknown as Stripe
})
const checkout = (price = "studio") => createCheckout(db, stripe, env, "owner", "qa@example.test", price)

describe("one unresolved Checkout per owner", () => {
  it("converges parallel same-offer requests to one customer and session", async () => {
    const results = await Promise.all([checkout(), checkout(), checkout()])
    expect(results.every((result) => result.url === "https://checkout.stripe.com/test")).toBe(true)
    expect(customers.size).toBe(1)
    expect(sessions).toHaveLength(1)
    expect(row.checkoutAttempt?.sessionId).toBe("cs_0")
  })
  it("expires the old payable session before switching to a new offer", async () => {
    await checkout()
    await checkout("house")
    expect(sessions).toHaveLength(2)
    expect(sessions[0].status).toBe("expired")
    expect(sessions.filter((session) => session.status === "open")).toHaveLength(1)
  })
  it("reconciles payment that wins the expiration race without opening another session", async () => {
    await checkout()
    vi.mocked(stripe.checkout.sessions.expire).mockImplementationOnce(async () => { sessions[0].status = "complete"; throw new Error("already completed") })
    await expect(checkout("house")).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_EXISTS" })
    expect(mocked.reconcileBilling).toHaveBeenCalled()
    expect(sessions).toHaveLength(1)
  })
  it("retains the attempt when expiration is not confirmed", async () => {
    await checkout()
    vi.mocked(stripe.checkout.sessions.expire).mockRejectedValueOnce(new Error("timeout"))
    await expect(checkout("house")).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNRESOLVED" })
    expect(sessions).toHaveLength(1)
    expect(row.checkoutAttempt?.sessionId).toBe("cs_0")
  })
  it("resumes a session created before a lost network response", async () => {
    const realCreate = sessionCreates.getMockImplementation()!
    sessionCreates.mockImplementationOnce(async (...args) => { await realCreate(...args); throw new Error("network timeout") })
    await expect(checkout()).rejects.toThrow("network timeout")
    expect(row.checkoutAttempt?.sessionId).toBeNull()
    await expect(checkout()).resolves.toHaveProperty("url")
    expect(sessions).toHaveLength(1)
  })
  it("reuses frozen customer arguments after a customer-create timeout", async () => {
    const realCreate = customerCreates.getMockImplementation()!
    customerCreates.mockImplementationOnce(async (...args) => { await realCreate(...args); throw new Error("timeout") })
    await expect(checkout()).rejects.toThrow("timeout")
    await createCheckout(db, stripe, env, "owner", "changed@example.test", "studio")
    expect(customers.size).toBe(1)
    expect(customerCreates.mock.calls[0]).toEqual(customerCreates.mock.calls[1])
  })
  it("recovers failed local session persistence without a second Stripe session", async () => {
    const realUpdate = mocked.updateBilling.getMockImplementation()!
    let lost = false
    mocked.updateBilling.mockImplementation(async (...args) => {
      if (!lost && args[2].checkoutAttempt?.sessionId) { lost = true; return null }
      return realUpdate(...args)
    })
    await expect(checkout()).resolves.toHaveProperty("url")
    expect(sessions).toHaveLength(1)
  })
  it("does not rotate an aged unknown Stripe outcome", async () => {
    row.checkoutAttempt = { id: "old", priceId: "studio", email: "qa@example.test", origin: "http://localhost:3000", startedAt: 1, sessionId: null }
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNRESOLVED" })
    expect(customerCreates).not.toHaveBeenCalled()
    expect(sessionCreates).not.toHaveBeenCalled()
    expect(row.checkoutAttempt.id).toBe("old")
  })
  it("permits replacement only after Stripe confirms the previous session expired", async () => {
    await checkout()
    sessions[0].status = "expired"
    await checkout("house")
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((session) => session.status === "open")).toHaveLength(1)
  })
  it("reconciles completion instead of replacing a completed session", async () => {
    await checkout()
    sessions[0].status = "complete"
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_EXISTS" })
    expect(mocked.reconcileBilling).toHaveBeenCalled()
    expect(sessions).toHaveLength(1)
  })
  it("detects an upstream subscription before a delayed webhook", async () => {
    row.customerId = "cus_existing"
    mocked.currentSubscription.mockResolvedValue({ id: "sub_existing", status: "active" })
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_EXISTS" })
    expect(sessionCreates).not.toHaveBeenCalled()
  })
  it("keeps unpaid subscriptions manageable without a second purchase", async () => {
    row.customerId = "cus_existing"
    mocked.currentSubscription.mockResolvedValue({ id: "sub_existing", status: "unpaid" })
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_EXISTS" })
  })
  it("rejects a foreign customer on a stored session", async () => {
    await checkout()
    sessions[0].customer = "cus_foreign"
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_CHECKOUT_MISMATCH" })
  })
  it("uses configured return URLs and frozen attempt parameters", async () => {
    await checkout()
    expect(sessionCreates.mock.calls[0][0]).toMatchObject({ success_url: "http://localhost:3000/c/me/bots?billing=checkout", cancel_url: "http://localhost:3000/c/me/bots?billing=cancel", mode: "subscription", managed_payments: { enabled: false } })
    expect(sessionCreates.mock.calls[0][1].idempotencyKey).toBe(`alook:checkout:${row.checkoutAttempt!.id}`)
  })
  it("requires Founder acknowledgment before purchase and returns normal offers", async () => {
    founder = true
    await expect(checkout()).rejects.toMatchObject({ code: "BILLING_FOUNDER_PROTECTED" })
    await expect(createPortal(db, stripe, env, "owner")).rejects.toMatchObject({ code: "BILLING_FOUNDER_PROTECTED" })
    const client = vi.fn(() => stripe)
    expect(await getBillingSummary(db, client, env, "owner")).toMatchObject({ isFounder: true, offers: [], subscription: null })
    expect(client).toHaveBeenCalledOnce()
    expect(customerCreates).not.toHaveBeenCalled()
  })
  it("freezes Founder consent and reuses the session while keeping Founder until payment", async () => {
    founder = true
    await expect(createCheckout(db, stripe, env, "owner", "qa@example.test", "house", false)).rejects.toMatchObject({ code: "BILLING_FOUNDER_PROTECTED" })
    await createCheckout(db, stripe, env, "owner", "qa@example.test", "house", true)
    expect(row.checkoutAttempt).toMatchObject({ founderAcknowledged: true, priceId: "house" })
    await createCheckout(db, stripe, env, "owner", "qa@example.test", "house", true)
    expect(sessions).toHaveLength(1)
    expect(founder).toBe(true)
    expect(mocked.reconcileBilling).not.toHaveBeenCalled()
  })
  it("does not reuse an unacknowledged old checkout for a Founder", async () => {
    await checkout()
    founder = true
    await expect(createCheckout(db, stripe, env, "owner", "qa@example.test", "studio", true)).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNRESOLVED" })
    expect(sessions).toHaveLength(1)
  })
  it("rejects a disabled or unknown offer before reserving an attempt", async () => {
    mocked.requireOffer.mockRejectedValue(new BillingError("BILLING_PRICE_UNAVAILABLE", 400))
    await expect(checkout("foreign")).rejects.toMatchObject({ code: "BILLING_PRICE_UNAVAILABLE" })
    expect(mocked.ensureBilling).not.toHaveBeenCalled()
  })
  it("chooses the target config for a change and the ordinary config for management", async () => {
    row.customerId = "cus_0"
    mocked.currentSubscription.mockResolvedValue({ id: "sub_1", status: "active", items: { data: [{ id: "si_1", quantity: 1 }] } })
    await createPortal(db, stripe, env, "owner", "house")
    expect(stripe.billingPortal.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({ customer: "cus_0", configuration: "bpc_house", flow_data: expect.objectContaining({ type: "subscription_update_confirm" }) }))
    await createPortal(db, stripe, env, "owner")
    expect(stripe.billingPortal.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({ configuration: "bpc_manage", flow_data: undefined }))
  })
})


describe("withdraw a future plan change", () => {
  function setupSchedule() {
    row.customerId = "cus_0"
    const schedule = { id: "sched_1", customer: "cus_0", subscription: "sub_1", livemode: false,
      status: "active", current_phase: { start_date: 1, end_date: 200 }, phases: [
        { start_date: 1, end_date: 200, items: [{ price: "house" }] },
        { start_date: 200, end_date: 201, items: [{ price: "studio" }] },
      ],
    }
    const sub = { id: "sub_1", cancel_at: 300, items: { data: [{ id: "si_1", price: { id: "house" }, quantity: 1 }] }, schedule }
    mocked.currentSubscription.mockResolvedValue(sub)
    const release = vi.fn(async () => ({ status: "released" }))
    const retrieve = vi.fn(async () => ({ status: "released" }))
    Object.assign(stripe, { subscriptionSchedules: { release, retrieve } })
    return { sub, schedule, release, retrieve }
  }
  it("releases only the future change, preserving cancellation and then reconciling", async () => {
    const { release } = setupSchedule()
    await cancelScheduledChange(db, stripe, env, "owner")
    expect(release).toHaveBeenCalledWith("sched_1", { preserve_cancel_date: true }, { idempotencyKey: "alook:release:sched_1" })
    expect(mocked.reconcileBilling).toHaveBeenCalledWith(db, stripe, env, "owner")
    expect(sessionCreates).not.toHaveBeenCalled()
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
  it("is a no-op when a repeated request finds no schedule", async () => {
    const { release, sub } = setupSchedule()
    mocked.currentSubscription.mockResolvedValue({ ...sub, schedule: null })
    await cancelScheduledChange(db, stripe, env, "owner")
    expect(release).not.toHaveBeenCalled()
    expect(mocked.reconcileBilling).toHaveBeenCalledOnce()
  })
  it("does not restore an old tier after the phase boundary has passed", async () => {
    const { release, sub, schedule } = setupSchedule()
    sub.items.data[0].price.id = "studio"
    schedule.current_phase = { start_date: 200, end_date: 201 }
    await cancelScheduledChange(db, stripe, env, "owner")
    expect(release).not.toHaveBeenCalled()
    expect(mocked.reconcileBilling).toHaveBeenCalledOnce()
  })
  it("recovers a release whose response was lost after Stripe committed", async () => {
    const { release, retrieve } = setupSchedule()
    release.mockRejectedValue(new Error("lost response"))
    await expect(cancelScheduledChange(db, stripe, env, "owner")).resolves.toHaveProperty("plan")
    expect(retrieve).toHaveBeenCalledWith("sched_1")
    expect(mocked.reconcileBilling).toHaveBeenCalledOnce()
  })
  it("leaves an unresolved release retryable", async () => {
    const { release, retrieve } = setupSchedule()
    release.mockRejectedValue(new Error("timeout"))
    retrieve.mockResolvedValue({ status: "active" })
    await expect(cancelScheduledChange(db, stripe, env, "owner")).rejects.toThrow("timeout")
    expect(mocked.reconcileBilling).not.toHaveBeenCalled()
  })
  it("rejects Founder and a foreign attached schedule without releasing", async () => {
    const { release, schedule } = setupSchedule()
    founder = true
    await expect(cancelScheduledChange(db, stripe, env, "owner")).rejects.toMatchObject({ code: "BILLING_FOUNDER_PROTECTED" })
    founder = false
    schedule.customer = "cus_foreign"
    await expect(cancelScheduledChange(db, stripe, env, "owner")).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_MISMATCH" })
    expect(release).not.toHaveBeenCalled()
  })
})
