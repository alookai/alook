import { beforeEach, describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
import type { Database } from "@alook/shared"

const mocked = vi.hoisted(() => ({ listPrices: vi.fn() }))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(),
  queries: { billing: mocked },
}))
import { getCatalog, requireOffer } from "./catalog"

const db = {} as Database
const env = { STRIPE_SECRET_KEY: "sk_test_fixture" } as Env
const mapping = { priceId: "studio", planId: "studio", displayName: "Studio", botLimit: 10, machineLimit: 5 }
const retrieve = vi.fn()
const stripe = { prices: { retrieve } } as unknown as Stripe

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listPrices.mockResolvedValue([mapping])
  retrieve.mockResolvedValue({
    id: "studio", active: true, livemode: false, type: "recurring", unit_amount: 2000,
    currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { active: true },
  })
})

describe("billing catalog purchase boundary", () => {
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
