import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocked = vi.hoisted(() => ({ listPrices: vi.fn(), getDefaultPlanOffer: vi.fn(), retrieve: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {}, STRIPE_SECRET_KEY: "sk_test_fake" } })) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(),
  queries: { billing: mocked },
}))
vi.mock("stripe", () => ({ default: class {
  static createFetchHttpClient() { return {} }
  prices = { retrieve: mocked.retrieve }
} }))
import { GET } from "./route"

const mapping = { priceId: "price_studio", planId: "studio", displayName: "Studio", botLimit: 10, machineLimit: 5, portalConfigurationId: "private_config", sortOrder: 1 }
const price = { id: "price_studio", active: true, livemode: false, type: "recurring", unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { active: true, metadata: { private: "hidden" } } }
const request = () => GET(new NextRequest("http://localhost/api/pricing"))

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listPrices.mockResolvedValue([mapping])
  mocked.getDefaultPlanOffer.mockResolvedValue({ plan: { id: "free", displayName: "Free" }, botLimit: 3, machineLimit: 1 })
  mocked.retrieve.mockResolvedValue(price)
})

describe("public pricing", () => {
  it("returns only public fields anonymously from the existing catalog", async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.json()).toEqual({
      free: { plan: { id: "free", displayName: "Free" }, botLimit: 3, machineLimit: 1 },
      offers: [{ priceId: "price_studio", plan: { id: "studio", displayName: "Studio" }, botLimit: 10, machineLimit: 5, unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1 }],
    })
    expect(mocked.listPrices).toHaveBeenCalledTimes(1)
    expect(mocked.getDefaultPlanOffer).toHaveBeenCalledTimes(1)
    expect(mocked.retrieve).toHaveBeenCalledWith("price_studio", { expand: ["product"] })
  })

  it("uses changed entitlement and Stripe amounts rather than marketing constants", async () => {
    mocked.listPrices.mockResolvedValue([{ ...mapping, botLimit: 17, machineLimit: 5, planId: "new-plan" }])
    mocked.getDefaultPlanOffer.mockResolvedValue({ plan: { id: "starter", displayName: "Starter" }, botLimit: 5, machineLimit: 1 })
    mocked.retrieve.mockResolvedValue({ ...price, unit_amount: 3100, currency: "eur", recurring: { interval: "year", interval_count: 2 } })
    expect(await (await request()).json()).toMatchObject({ free: { botLimit: 5, machineLimit: 1, plan: { id: "starter" } }, offers: [{ botLimit: 17, machineLimit: 5, unitAmount: 3100, currency: "eur", interval: "year", intervalCount: 2, plan: { id: "new-plan" } }] })
  })

  it.each([
    { active: false }, { recurring: null }, { type: "one_time" }, { unit_amount: null },
    { product: { active: false } }, { product: { deleted: true } },
  ])("omits unavailable Stripe prices: %j", async (change) => {
    mocked.retrieve.mockResolvedValue({ ...price, ...change })
    expect(await (await request()).json()).toMatchObject({ offers: [] })
  })

  it("returns an empty paid catalog without inventing prices", async () => {
    mocked.listPrices.mockResolvedValue([])
    expect(await (await request()).json()).toMatchObject({ offers: [] })
    expect(mocked.retrieve).not.toHaveBeenCalled()
  })

  it("fails closed on a Stripe environment mismatch", async () => {
    mocked.retrieve.mockResolvedValue({ ...price, livemode: true })
    const response = await request()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "BILLING_ENVIRONMENT_MISMATCH" })
  })

  it.each(["stripe", "default", "invalid quota"])("returns a retryable sanitized error for %s failure", async (failure) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    if (failure === "stripe") mocked.retrieve.mockRejectedValue(new Error("private upstream details"))
    if (failure === "default") mocked.getDefaultPlanOffer.mockRejectedValue(new Error("DEFAULT_PLAN_UNAVAILABLE"))
    if (failure === "invalid quota") mocked.getDefaultPlanOffer.mockResolvedValue({ plan: { id: "free", displayName: "Free" }, botLimit: -1 })
    const response = await request()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "BILLING_UNAVAILABLE" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    log.mockRestore()
  })
})
