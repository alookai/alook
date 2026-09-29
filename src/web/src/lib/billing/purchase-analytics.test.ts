import { beforeEach, describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
import type { Database } from "@alook/shared"

const mocked = vi.hoisted(() => ({
  claimPurchaseDelivery: vi.fn(),
  finalizePurchaseDelivery: vi.fn(),
  getAnalyticsConsent: vi.fn(),
  listPrices: vi.fn(),
}))
vi.mock("@alook/shared", () => ({ queries: { billing: mocked } }))
import { deliverInvoicePurchase } from "./purchase-analytics"

const db = {} as Database
const env = { STRIPE_SECRET_KEY: "sk_test_fixture", GA4_API_SECRET: "ga-secret" } as Env
const catalog = [
  { priceId: "price_studio", planId: "studio", displayName: "Studio", sortOrder: 1 },
  { priceId: "price_house", planId: "house", displayName: "House", sortOrder: 2 },
]

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_current", livemode: false, status: "paid", amount_paid: 2400,
    currency: "usd", created: 200, customer: "cus_owner", billing_reason: "subscription_create",
    parent: { subscription_details: { subscription: "sub_owner" } },
    ...overrides,
  } as unknown as Stripe.Invoice
}

function line(price: string, amount: number, subscription = "sub_owner") {
  return {
    amount,
    parent: { subscription_item_details: { subscription } },
    pricing: { price_details: { price } },
  } as unknown as Stripe.InvoiceLineItem
}

function iterable<T>(values: T[]) {
  return { async *[Symbol.asyncIterator]() { yield* values } }
}

let currentInvoice: Stripe.Invoice
let lines: Stripe.InvoiceLineItem[]
let priorInvoices: Stripe.Invoice[]
let stripe: Stripe
let fetcher: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  currentInvoice = invoice()
  lines = [line("price_studio", 2000), { amount: 400 } as Stripe.InvoiceLineItem]
  priorInvoices = [currentInvoice]
  mocked.claimPurchaseDelivery.mockResolvedValue(true)
  mocked.finalizePurchaseDelivery.mockResolvedValue(true)
  mocked.getAnalyticsConsent.mockResolvedValue({ decision: "granted", revision: 2 })
  mocked.listPrices.mockResolvedValue(catalog)
  stripe = {
    invoices: {
      retrieve: vi.fn(async () => currentInvoice),
      listLineItems: vi.fn(() => iterable(lines)),
      list: vi.fn(() => iterable(priorInvoices)),
    },
    subscriptions: {
      retrieve: vi.fn(async () => ({
        id: "sub_owner", livemode: false, customer: "cus_owner",
        metadata: {
          alook_user_id: "owner",
          alook_ga_client_id: "123456789.1700000000",
          alook_ga_session_id: "1700000000",
          alook_ga_consent_revision: "2",
        },
      })),
    },
  } as unknown as Stripe
  fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ validationMessages: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetcher)
})

describe("server GA4 purchase delivery", () => {
  it("sends an initial tax-exclusive purchase with checkout session attribution", async () => {
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledTimes(2)
    const debugPayload = JSON.parse(fetcher.mock.calls[0][1].body as string)
    expect(debugPayload).toMatchObject({
      client_id: "123456789.1700000000",
      validation_behavior: "ENFORCE_RECOMMENDATIONS",
      events: [{ name: "purchase", params: {
        transaction_id: "in_current", currency: "USD", value: 20,
        purchase_type: "initial_subscription", session_id: 1700000000,
        items: [{ item_id: "studio", item_name: "Studio", price: 20, quantity: 1 }],
      } }],
    })
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "sent", purchaseType: "initial_subscription", valueMinor: 2000,
    }))
  })

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-session"],
  ])("skips an initial purchase with %s session identity", async (_name, sessionId) => {
    const metadata: Record<string, string> = {
      alook_user_id: "owner",
      alook_ga_client_id: "123456789.1700000000",
      alook_ga_consent_revision: "2",
    }
    if (sessionId) metadata.alook_ga_session_id = sessionId
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({
      id: "sub_owner", livemode: false, customer: "cus_owner", metadata,
    } as unknown as Stripe.Subscription)

    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")

    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "session_identity_invalid",
    }))
  })

  it.each([
    ["renewal", "subscription_cycle", [line("price_studio", 2000)], "renewal"],
    ["upgrade", "subscription_update", [line("price_studio", -1000), line("price_house", 3000)], "upgrade"],
    ["ambiguous update", "subscription_update", [line("price_house", 2000)], "other"],
    ["resubscription", "subscription_create", [line("price_studio", 2000)], "other"],
  ])("classifies %s and never reuses the old session", async (_name, reason, invoiceLines, expected) => {
    currentInvoice = invoice({ billing_reason: reason })
    lines = invoiceLines
    priorInvoices = [invoice({ id: "in_prior", created: 100 }), currentInvoice]
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    const payload = JSON.parse(fetcher.mock.calls[0][1].body as string)
    expect(payload.events[0].params.purchase_type).toBe(expected)
    expect(payload.events[0].params).not.toHaveProperty("session_id")
  })

  it("records later consent withdrawal as revoked without network delivery", async () => {
    mocked.getAnalyticsConsent.mockResolvedValue({ decision: "denied", revision: 3 })
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "consent_revoked",
    }))
  })

  it("keeps a replayed stale grant auditable and suppresses duplicate webhook attempts", async () => {
    mocked.getAnalyticsConsent.mockResolvedValue({ decision: "denied", revision: 2, sourceVersion: 200 })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({
      id: "sub_owner", livemode: false, customer: "cus_owner",
      metadata: { alook_user_id: "owner", alook_ga_consent_status: "stale_consent_proof" },
    } as unknown as Stripe.Subscription)
    mocked.claimPurchaseDelivery.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")

    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.claimPurchaseDelivery).toHaveBeenCalledTimes(2)
    expect(mocked.finalizePurchaseDelivery).toHaveBeenCalledOnce()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "stale_consent_proof",
    }))
  })

  it("records zero-value and credit-covered invoices as skipped", async () => {
    currentInvoice = invoice({ amount_paid: 0 })
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "invoice_ineligible",
    }))
  })

  it("does not send when configuration or debug validation fails", async () => {
    await deliverInvoicePurchase(db, stripe, { ...env, GA4_API_SECRET: undefined }, currentInvoice, "owner")
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "ga_configuration_missing",
    }))

    fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ validationMessages: [{
      fieldPath: "events[0]", description: "invalid", validationCode: "VALUE_INVALID",
    }] }), { status: 200 }))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "validation_rejected",
      validationJson: expect.not.stringContaining("ga-secret"),
    }))
  })

  it("fails closed when the debug endpoint returns malformed evidence", async () => {
    fetcher.mockReset().mockResolvedValueOnce(new Response("not-json", { status: 200 }))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "validation_response_invalid",
    }))
  })

  it("keeps an ambiguous collection failure auditable and suppresses duplicate attempts", async () => {
    fetcher.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ validationMessages: [] }), { status: 200 }))
      .mockRejectedValueOnce(new Error("timeout"))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "collection_transport_ambiguous",
    }))
    mocked.claimPurchaseDelivery.mockResolvedValue(false)
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
