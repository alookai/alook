import { beforeEach, describe, expect, it, vi } from "vitest"
import Stripe from "stripe"
import type { Database } from "@alook/shared"
const mocked = vi.hoisted(() => ({ getBillingByCustomer: vi.fn(), getBilling: vi.fn(), getEffectivePlan: vi.fn(), updateBilling: vi.fn(), reconcileBilling: vi.fn() }))
vi.mock("@alook/shared", () => ({ queries: { billing: mocked } }))
vi.mock("./reconcile", () => ({ reconcileBilling: mocked.reconcileBilling }))
import { handleBillingWebhook } from "./webhook"

const db = {} as Database
const stripe = new Stripe("sk_test_fixture")
const env = { STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture" } as Env
const body = (object: Record<string, unknown> = { customer: "cus_owner" }, livemode = false) => JSON.stringify({
  id: "evt_fixture", object: "event", type: "invoice.paid", livemode, data: { object },
}, null, 2)
const signature = (raw: string) => stripe.webhooks.generateTestHeaderString({ payload: raw, secret: env.STRIPE_WEBHOOK_SECRET! })

beforeEach(() => {
  vi.resetAllMocks()
  mocked.getBillingByCustomer.mockResolvedValue({ userId: "owner", customerId: "cus_owner", revision: 2 })
})

describe("Stripe signed ingress", () => {
  it("verifies the untouched formatted body and reconciles its server-owned customer", async () => {
    const raw = body()
    await handleBillingWebhook(db, stripe, env, raw, signature(raw))
    expect(mocked.reconcileBilling).toHaveBeenCalledWith(db, stripe, env, "owner")
  })
  it.each([null, "invalid"])("rejects missing or invalid signatures before database access", async (header) => {
    await expect(handleBillingWebhook(db, stripe, env, body(), header)).rejects.toMatchObject({ code: "BILLING_SIGNATURE_INVALID", status: 400 })
    expect(mocked.getBillingByCustomer).not.toHaveBeenCalled()
  })
  it("rejects a parsed-and-reserialized body against the original signature", async () => {
    const raw = body()
    await expect(handleBillingWebhook(db, stripe, env, JSON.stringify(JSON.parse(raw)), signature(raw))).rejects.toMatchObject({ code: "BILLING_SIGNATURE_INVALID" })
  })
  it("rejects the wrong Stripe environment before touching entitlements", async () => {
    const raw = body(undefined, true)
    await expect(handleBillingWebhook(db, stripe, env, raw, signature(raw))).rejects.toMatchObject({ code: "BILLING_ENVIRONMENT_MISMATCH" })
    expect(mocked.reconcileBilling).not.toHaveBeenCalled()
  })
  it("lets a durable reconciliation failure propagate for webhook retry", async () => {
    mocked.reconcileBilling.mockRejectedValue(new Error("D1 unavailable"))
    const raw = body()
    await expect(handleBillingWebhook(db, stripe, env, raw, signature(raw))).rejects.toThrow("D1 unavailable")
  })
  it("reconciles duplicates again instead of treating event receipt as completed work", async () => {
    const raw = body()
    await handleBillingWebhook(db, stripe, env, raw, signature(raw))
    await handleBillingWebhook(db, stripe, env, raw, signature(raw))
    expect(mocked.reconcileBilling).toHaveBeenCalledTimes(2)
  })
  it("recovers a customer created before local persistence only for the matching reserved attempt", async () => {
    mocked.getBillingByCustomer.mockResolvedValue(null)
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({ id: "cus_owner", livemode: false, metadata: { alook_user_id: "owner", alook_attempt_id: "attempt" } } as Stripe.Response<Stripe.Customer>)
    mocked.getBilling.mockResolvedValue({ userId: "owner", customerId: null, checkoutAttempt: { id: "attempt" }, revision: 1 })
    mocked.getEffectivePlan.mockResolvedValue({ isFounder: false })
    mocked.updateBilling.mockResolvedValue({ userId: "owner", customerId: "cus_owner", revision: 2 })
    const raw = body()
    await handleBillingWebhook(db, stripe, env, raw, signature(raw))
    expect(mocked.updateBilling).toHaveBeenCalledWith(db, expect.objectContaining({ revision: 1 }), { customerId: "cus_owner" })
    expect(mocked.reconcileBilling).toHaveBeenCalledWith(db, stripe, env, "owner")
  })
  it("does not adopt a foreign or obsolete attempt's customer", async () => {
    mocked.getBillingByCustomer.mockResolvedValue(null)
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({ id: "cus_owner", livemode: false, metadata: { alook_user_id: "owner", alook_attempt_id: "old" } } as Stripe.Response<Stripe.Customer>)
    mocked.getBilling.mockResolvedValue({ userId: "owner", customerId: null, checkoutAttempt: { id: "new" } })
    const raw = body()
    await handleBillingWebhook(db, stripe, env, raw, signature(raw))
    expect(mocked.updateBilling).not.toHaveBeenCalled()
    expect(mocked.reconcileBilling).not.toHaveBeenCalled()
  })
})

it("ignores a validly signed unrelated event without looking up billing", async () => {
  const raw = JSON.stringify({ ...JSON.parse(body()), type: "payment_intent.succeeded" })
  await handleBillingWebhook(db, stripe, env, raw, signature(raw))
  expect(mocked.getBillingByCustomer).not.toHaveBeenCalled()
  expect(mocked.reconcileBilling).not.toHaveBeenCalled()
})
