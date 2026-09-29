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
import { deliverInvoicePurchase, validatePurchasePayloadForAcceptance } from "./purchase-analytics"

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
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetcher)
})

describe("server GA4 purchase delivery", () => {
  it("sends an initial tax-exclusive purchase with checkout session attribution", async () => {
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toContain("/mp/collect?")
    expect(fetcher.mock.calls[0][0]).not.toContain("/debug/")
    const payload = JSON.parse(fetcher.mock.calls[0][1].body as string)
    expect(payload).toMatchObject({
      client_id: "123456789.1700000000",
      events: [{ name: "purchase", params: {
        transaction_id: "in_current", currency: "USD", value: 20,
        purchase_type: "initial_subscription", session_id: 1700000000,
        items: [{ item_id: "studio", item_name: "Studio", price: 20, quantity: 1 }],
      } }],
    })
    expect(payload).not.toHaveProperty("validation_behavior")
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

  it("does not revive checkout identity after consent is denied and granted again", async () => {
    mocked.getAnalyticsConsent.mockResolvedValue({ decision: "granted", revision: 4 })
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "consent_revision_changed",
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

  it("records invoice retrieval failure", async () => {
    vi.mocked(stripe.invoices.retrieve).mockRejectedValue(new Error("offline"))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", {
      status: "failed", reason: "invoice_retrieval_failed",
    })
  })

  it("rejects a webhook invoice whose customer differs from the retrieved invoice", async () => {
    await deliverInvoicePurchase(db, stripe, env, invoice({ customer: "cus_other" }), "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", {
      status: "failed", reason: "invoice_customer_mismatch",
    })
  })

  it("records purchase context retrieval failure", async () => {
    mocked.listPrices.mockRejectedValue(new Error("offline"))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", {
      status: "failed", reason: "purchase_context_failed",
    })
  })

  it("rejects a subscription owned by a different customer or user", async () => {
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({
      id: "sub_owner", livemode: false, customer: "cus_other", metadata: { alook_user_id: "owner" },
    } as unknown as Stripe.Subscription)
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", {
      status: "failed", reason: "subscription_mismatch",
    })
  })

  it("skips invoice lines that do not map to an eligible paid plan", async () => {
    lines = [line("price_unknown", 2000)]
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", {
      status: "skipped", reason: "invoice_items_ineligible", currency: "USD", valueMinor: 2000,
    })
  })

  it("records purchase classification failure", async () => {
    stripe.invoices.list = vi.fn(() => ({ async *[Symbol.asyncIterator]() { throw new Error("offline") } })) as unknown as typeof stripe.invoices.list
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "purchase_classification_failed",
    }))
  })

  it("records consent lookup failure", async () => {
    mocked.getAnalyticsConsent.mockRejectedValue(new Error("offline"))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "consent_lookup_failed",
    }))
  })

  it("skips when current consent or checkout identity is unavailable", async () => {
    mocked.getAnalyticsConsent.mockResolvedValue(null)
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "skipped", reason: "consent_or_identity_unavailable",
    }))
  })

  it("does not send when configuration is missing", async () => {
    await deliverInvoicePurchase(db, stripe, { ...env, GA4_API_SECRET: undefined }, currentInvoice, "owner")
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "ga_configuration_missing",
    }))
  })

  it("keeps debug validation in an explicit acceptance-only helper", async () => {
    fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ validationMessages: [{
      fieldPath: "events[0]", description: "invalid", validationCode: "VALUE_INVALID",
    }] }), { status: 200 }))
    const result = await validatePurchasePayloadForAcceptance(env, {
      client_id: "123456789.1700000000",
      events: [{ name: "purchase", params: { transaction_id: "in_acceptance" } }],
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toContain("/debug/mp/collect?")
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({
      validation_behavior: "ENFORCE_RECOMMENDATIONS",
      events: [{ name: "purchase", params: { transaction_id: "in_acceptance" } }],
    })
    expect(result).toMatchObject({ ok: false, reason: "validation_rejected", validationJson: expect.not.stringContaining("ga-secret") })
  })

  it("acceptance validation reports missing configuration, transport, HTTP, and success", async () => {
    const payload = { client_id: "fixture", events: [] }
    await expect(validatePurchasePayloadForAcceptance({ ...env, GA4_API_SECRET: undefined }, payload))
      .resolves.toEqual({ ok: false, reason: "ga_configuration_missing" })
    expect(fetcher).not.toHaveBeenCalled()

    fetcher.mockRejectedValueOnce(new Error("offline"))
    await expect(validatePurchasePayloadForAcceptance(env, payload))
      .resolves.toEqual({ ok: false, reason: "validation_transport_failed" })

    fetcher.mockResolvedValueOnce(new Response(null, { status: 429 }))
    await expect(validatePurchasePayloadForAcceptance(env, payload))
      .resolves.toEqual({ ok: false, reason: "validation_http_429" })

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ validationMessages: [] }), { status: 200 }))
    await expect(validatePurchasePayloadForAcceptance(env, payload)).resolves.toEqual({
      ok: true, reason: "accepted", validationJson: '{"validationMessages":[]}',
    })
  })

  it("fails closed when the debug endpoint returns malformed evidence", async () => {
    fetcher.mockReset().mockResolvedValueOnce(new Response("not-json", { status: 200 }))
    const result = await validatePurchasePayloadForAcceptance(env, { client_id: "fixture", events: [] })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: false, reason: "validation_response_invalid" })
  })

  it("keeps an ambiguous collection failure auditable and suppresses duplicate attempts", async () => {
    fetcher.mockReset().mockRejectedValueOnce(new Error("timeout"))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "collection_transport_ambiguous",
    }))
    mocked.claimPurchaseDelivery.mockResolvedValue(false)
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("records a non-success collection response", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await deliverInvoicePurchase(db, stripe, env, currentInvoice, "owner")
    expect(mocked.finalizePurchaseDelivery).toHaveBeenLastCalledWith(db, "in_current", expect.objectContaining({
      status: "failed", reason: "collection_http_503",
    }))
  })
})
