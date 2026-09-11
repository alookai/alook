import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  session: vi.fn(), owner: vi.fn(), summary: vi.fn(), checkout: vi.fn(),
  portal: vi.fn(), cancel: vi.fn(), webhook: vi.fn(),
  db: { primary: true }, env: { DB: {}, STRIPE_SECRET_KEY: "sk_test_route_fixture" },
}))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: mocks.env, ctx: { waitUntil: vi.fn() } })),
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => mocks.db), getDb: vi.fn(() => mocks.db) }))
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({ api: { getSession: mocks.session, signOut: vi.fn() } })),
}))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(),
  queries: { user: { getUserInternal: mocks.owner } },
}))
vi.mock("@/lib/billing/service", () => ({
  getBillingSummary: mocks.summary, createCheckout: mocks.checkout,
  createPortal: mocks.portal, cancelScheduledChange: mocks.cancel,
}))
vi.mock("@/lib/billing/webhook", () => ({ handleBillingWebhook: mocks.webhook }))

import { GET } from "./route"
import { POST as checkout } from "./checkout/route"
import { POST as portal } from "./portal/route"
import { POST as cancel } from "./cancel-change/route"
import { POST as webhook } from "../../stripe/webhook/route"
import { BillingError } from "@/lib/billing/client"

const summary = { plan: { id: "free", displayName: "Free" }, isFounder: false, offers: [], subscription: null }
const redirect = { url: "https://checkout.stripe.com/session" }
const owner = { id: "owner", email: "current@example.test", isBot: false, deletedAt: null }
const request = (body?: string, headers: Record<string, string> = {}) => new NextRequest("https://alook.ai/api/billing", {
  method: "POST", body, headers: { origin: "https://alook.ai", ...headers },
})
const getRequest = (headers: Record<string, string> = {}) => new NextRequest("https://alook.ai/api/community/billing", { headers })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.session.mockResolvedValue({ headers: new Headers(), response: { user: { ...owner, email: "stale@example.test" } } })
  mocks.owner.mockResolvedValue(owner)
  mocks.summary.mockResolvedValue(summary)
  mocks.checkout.mockResolvedValue(redirect)
  mocks.portal.mockResolvedValue(redirect)
  mocks.cancel.mockResolvedValue(summary)
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("billing HTTP route boundaries", () => {
  it("returns validated private summary for a live cookie owner", async () => {
    mocks.summary.mockImplementationOnce(async (_db, client) => {
      expect(client()).toHaveProperty("checkout")
      return summary
    })
    const response = await GET(getRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(summary)
    expect(mocks.summary).toHaveBeenCalledWith(mocks.db, expect.any(Function), mocks.env, owner.id)
  })

  it.each(["anonymous", "authorization", "bot", "deleted", "missing"] as const)("rejects %s summary access without service work", async (kind) => {
    if (kind === "anonymous") mocks.session.mockResolvedValue({ response: null })
    if (kind === "bot") mocks.owner.mockResolvedValue({ ...owner, isBot: true })
    if (kind === "deleted") mocks.owner.mockResolvedValue({ ...owner, deletedAt: "2026-01-01" })
    if (kind === "missing") mocks.owner.mockResolvedValue(null)
    const response = await GET(getRequest(kind === "authorization" ? { Authorization: "Bearer machine" } : {}))
    expect(response.status).toBe(401)
    expect(mocks.summary).not.toHaveBeenCalled()
  })

  it.each([true, false, undefined])("forwards validated Checkout consent %s with live owner email", async (founderAcknowledged) => {
    const response = await checkout(request(JSON.stringify({ priceId: "price_studio", founderAcknowledged })))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(redirect)
    expect(mocks.checkout).toHaveBeenCalledWith(mocks.db, expect.any(Object), mocks.env, owner.id, owner.email, "price_studio", founderAcknowledged)
  })

  it.each(["{", "null", "{}", '{"priceId":""}', '{"priceId":"p","founderAcknowledged":"true"}', '{"priceId":"p","ownerId":"other"}'])("rejects malformed Checkout body %s before creating a Session", async (body) => {
    const response = await checkout(request(body))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "BILLING_REQUEST_INVALID" })
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it.each(["", "{}", '{"priceId":"price_house"}'])("accepts Portal body %s", async (body) => {
    expect((await portal(request(body))).status).toBe(200)
    expect(mocks.portal).toHaveBeenCalledWith(mocks.db, expect.any(Object), mocks.env, owner.id, body.includes("price_house") ? "price_house" : undefined)
  })

  it.each(["{", "null", "[]", '{"priceId":""}', '{"customerId":"other"}'])("rejects invalid Portal body %s", async (body) => {
    expect((await portal(request(body))).status).toBe(400)
    expect(mocks.portal).not.toHaveBeenCalled()
  })

  it.each(["", "  ", "{}"])("accepts empty cancel-change body %s", async (body) => {
    const response = await cancel(request(body))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(summary)
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.db, expect.any(Object), mocks.env, owner.id)
  })

  it.each(["{", "null", "[]", "false", "1", '"text"', '{"subscriptionId":"other"}'])("rejects nonempty cancel-change input %s", async (body) => {
    expect((await cancel(request(body))).status).toBe(400)
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  describe.each([
    ["checkout", checkout, mocks.checkout, '{"priceId":"price_studio"}'],
    ["portal", portal, mocks.portal, "{}"],
    ["cancel", cancel, mocks.cancel, "{}"],
  ] as const)("%s authentication and failures", (_name, handler, service, body) => {
    it.each(["cross-origin", "authorization", "anonymous", "deleted", "bot"] as const)("blocks %s before reaching billing service", async (kind) => {
      if (kind === "anonymous") mocks.session.mockResolvedValue({ response: null })
      if (kind === "deleted") mocks.owner.mockResolvedValue({ ...owner, deletedAt: "2026-01-01" })
      if (kind === "bot") mocks.owner.mockResolvedValue({ ...owner, isBot: true })
      const headers: Record<string, string> = kind === "cross-origin" ? { origin: "https://evil.example" } : kind === "authorization" ? { Authorization: "Bearer machine" } : {}
      expect((await handler(request(body, headers))).status).toBe(kind === "cross-origin" ? 403 : 401)
      expect(service).not.toHaveBeenCalled()
    })

    it("preserves explicit billing failure and avoids caching", async () => {
      service.mockRejectedValue(new BillingError("BILLING_FOUNDER_PROTECTED", 403))
      const response = await handler(request(body))
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ error: "BILLING_FOUNDER_PROTECTED" })
    })

    it("sanitizes service failures", async () => {
      service.mockRejectedValue(new Error("private upstream body"))
      const response = await handler(request(body))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "BILLING_UNAVAILABLE" })
    })

    it("rejects invalid service response instead of leaking it", async () => {
      service.mockResolvedValue({ private: "data" })
      const response = await handler(request(body))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "BILLING_UNAVAILABLE" })
    })
  })

  it("sanitizes summary lookup failures", async () => {
    mocks.owner.mockRejectedValue(new Error("private database detail"))
    const response = await GET(getRequest())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "BILLING_UNAVAILABLE" })
  })
})

describe("Stripe webhook HTTP ingress", () => {
  it.each(["t=123,v1=fixture", null])("passes exact raw bytes and signature %s without cookie auth", async (signature) => {
    const raw = '{  "id": "evt_fixture",\n "data": {} }\n'
    const response = await webhook(request(raw, signature ? { "stripe-signature": signature } : {}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mocks.webhook).toHaveBeenCalledWith(mocks.db, expect.any(Object), mocks.env, raw, signature)
    expect(mocks.session).not.toHaveBeenCalled()
  })

  it.each([
    [new BillingError("BILLING_SIGNATURE_INVALID", 400), 400, "BILLING_SIGNATURE_INVALID"],
    [new Error("private upstream detail"), 503, "BILLING_UNAVAILABLE"],
  ] as const)("returns handler error safely", async (error, status, code) => {
    mocks.webhook.mockRejectedValue(error)
    const response = await webhook(request("{}"))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })
})
