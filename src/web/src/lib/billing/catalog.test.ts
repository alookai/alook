import { beforeEach, describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
import type { Database } from "@alook/shared"

const mocked = vi.hoisted(() => ({ listPrices: vi.fn(), getDefaultPlanOffer: vi.fn() }))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(),
  queries: { billing: mocked },
}))
import { getCatalog, getOffers, getPublicPricing, requireOffer } from "./catalog"
import { billingClient } from "./client"

const db = {} as Database
const env = { STRIPE_SECRET_KEY: "sk_test_fixture" } as Env
const mapping = { priceId: "studio", planId: "studio", displayName: "Studio", botLimit: 10, machineLimit: 5 }
const retrieve = vi.fn()
const stripe = { prices: { retrieve } } as unknown as Stripe

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listPrices.mockResolvedValue([mapping])
  mocked.getDefaultPlanOffer.mockResolvedValue({ plan: { id: "starter", displayName: "Starter" }, botLimit: 7, machineLimit: 2 })
  retrieve.mockImplementation(async (priceId: string) => ({
    id: priceId, active: true, livemode: false, type: "recurring", unit_amount: 2000,
    currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { active: true },
  }))
})

describe("billing catalog purchase boundary", () => {
  it("returns the database free offer without a Stripe client for an empty paid catalog", async () => {
    mocked.listPrices.mockResolvedValue([])
    const client = vi.fn(() => billingClient({} as Env))
    expect(await getPublicPricing(db, client, {} as Env)).toEqual({
      free: { plan: { id: "starter", displayName: "Starter" }, botLimit: 7, machineLimit: 2 },
      offers: [],
    })
    expect(client).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
  })
  it("uses one Stripe client to validate all actual paid mappings", async () => {
    mocked.listPrices.mockResolvedValue([mapping, { ...mapping, priceId: "house", planId: "house", displayName: "House" }])
    const client = vi.fn(() => stripe)
    const offers = await getOffers(db, client, env)
    expect(client).toHaveBeenCalledOnce()
    expect(offers.map(offer => offer.plan.id)).toEqual(["studio", "house"])
    expect(offers.map(offer => offer.priceId)).toEqual(["studio", "house"])
    expect(retrieve.mock.calls).toEqual([
      ["studio", { expand: ["product"] }],
      ["house", { expand: ["product"] }],
    ])
  })
  it("does not treat a failed mapping lookup as an empty paid catalog", async () => {
    mocked.listPrices.mockRejectedValue(new Error("catalog database unavailable"))
    const client = vi.fn(() => stripe)
    await expect(getOffers(db, client, env)).rejects.toThrow("catalog database unavailable")
    expect(client).not.toHaveBeenCalled()
  })
  it("still requires Stripe configuration for a mapped paid offer", async () => {
    await expect(getOffers(db, () => billingClient({} as Env), {} as Env))
      .rejects.toMatchObject({ code: "BILLING_UNAVAILABLE", status: 503 })
    expect(retrieve).not.toHaveBeenCalled()
  })
  it("still rejects a mapped offer from the wrong Stripe mode", async () => {
    retrieve.mockResolvedValue({ active: true, livemode: true })
    await expect(getOffers(db, () => stripe, env))
      .rejects.toMatchObject({ code: "BILLING_ENVIRONMENT_MISMATCH", status: 503 })
  })
  it("includes disabled mappings when reconciling historical purchases", async () => {
    expect(await getCatalog(db)).toEqual([mapping])
    expect(mocked.listPrices).toHaveBeenCalledWith(db, true)
    expect(retrieve).not.toHaveBeenCalled()
  })
  it("requires an enabled server mapping and validates the actual Stripe price", async () => {
    expect(await requireOffer(db, stripe, env, "studio")).toEqual({
      priceId: "studio", plan: { id: "studio", displayName: "Studio" }, botLimit: 10, machineLimit: 5,
      unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1,
    })
    expect(mocked.listPrices).toHaveBeenCalledWith(db)
    expect(retrieve).toHaveBeenCalledWith("studio", { expand: ["product"] })
  })
  it("rejects unlisted prices without asking Stripe", async () => {
    await expect(requireOffer(db, stripe, env, "foreign")).rejects.toMatchObject({ code: "BILLING_PRICE_UNAVAILABLE", status: 400 })
    expect(retrieve).not.toHaveBeenCalled()
  })
  it("rejects a mapped price disabled upstream", async () => {
    retrieve.mockResolvedValue({ active: false, livemode: false })
    await expect(requireOffer(db, stripe, env, "studio")).rejects.toMatchObject({ code: "BILLING_PRICE_UNAVAILABLE", status: 400 })
  })
})
