import { queries, type Database } from "@alook/shared"
import type Stripe from "stripe"
import { assertStripeMode, stripeId } from "./client"
import { stripeAmountToMajorUnit } from "./currency"
import {
  GA4_CLIENT_ID_METADATA,
  GA4_CONSENT_REVISION_METADATA,
  GA4_CONSENT_STATUS_METADATA,
  GA4_MEASUREMENT_ID,
  GA4_SESSION_ID_METADATA,
  parseGaClientId,
  parseGaSessionId,
} from "@/lib/analytics-consent-server"

const GA_TIMEOUT_MS = 2_500
const MAX_VALIDATION_MESSAGES = 10
const MAX_VALIDATION_TEXT = 300
const PLAN_NAMES = { studio: "Studio", house: "House" } as const

type CatalogEntry = Awaited<ReturnType<typeof queries.billing.listPrices>>[number]
type PurchaseType = "initial_subscription" | "renewal" | "upgrade" | "other"
type InvoiceWithLegacySubscription = Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }

type ValidationMessage = {
  fieldPath?: string
  description?: string
  validationCode?: string
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription
    ?? (invoice as InvoiceWithLegacySubscription).subscription)
}

function lineSubscriptionId(line: Stripe.InvoiceLineItem): string | null {
  return stripeId(line.parent?.subscription_item_details?.subscription ?? line.subscription)
}

function linePriceId(line: Stripe.InvoiceLineItem): string | null {
  return stripeId(line.pricing?.price_details?.price)
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_VALIDATION_TEXT) : undefined
}

function validationEvidence(value: unknown): { json: string; hasErrors: boolean } | null {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { validationMessages?: unknown }).validationMessages
    : null
  if (!Array.isArray(source)) return null
  const messages = Array.isArray(source) ? source.slice(0, MAX_VALIDATION_MESSAGES).map((item): ValidationMessage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return {}
    const message = item as Record<string, unknown>
    return {
      fieldPath: boundedText(message.fieldPath),
      description: boundedText(message.description),
      validationCode: boundedText(message.validationCode),
    }
  }) : []
  return { json: JSON.stringify({ validationMessages: messages }), hasErrors: messages.length > 0 }
}

export async function validatePurchasePayloadForAcceptance(
  env: Env,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; reason: string; validationJson?: string }> {
  if (!env.GA4_API_SECRET) return { ok: false, reason: "ga_configuration_missing" }
  const query = new URLSearchParams({ measurement_id: GA4_MEASUREMENT_ID, api_secret: env.GA4_API_SECRET })
  let response: Response
  try {
    response = await fetchWithTimeout(`https://www.google-analytics.com/debug/mp/collect?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, validation_behavior: "ENFORCE_RECOMMENDATIONS" }),
    })
  } catch {
    return { ok: false, reason: "validation_transport_failed" }
  }
  if (!response.ok) return { ok: false, reason: `validation_http_${response.status}` }
  let evidence: ReturnType<typeof validationEvidence>
  try {
    evidence = validationEvidence(await response.json())
  } catch {
    evidence = null
  }
  if (!evidence) return { ok: false, reason: "validation_response_invalid" }
  if (evidence.hasErrors) return { ok: false, reason: "validation_rejected", validationJson: evidence.json }
  return { ok: true, reason: "accepted", validationJson: evidence.json }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GA_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function invoiceLines(stripe: Stripe, invoiceId: string) {
  const lines: Stripe.InvoiceLineItem[] = []
  for await (const line of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) lines.push(line)
  return lines
}

function positivePaidSubscriptionInvoice(invoice: Stripe.Invoice): boolean {
  return invoice.status === "paid" && invoice.amount_paid > 0 && invoiceSubscriptionId(invoice) !== null
}

async function hasEarlierPositiveInvoice(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  customerId: string,
): Promise<boolean> {
  for await (const candidate of stripe.invoices.list({ customer: customerId, status: "paid", limit: 100 })) {
    if (candidate.id === invoice.id || candidate.created > invoice.created) continue
    if (positivePaidSubscriptionInvoice(candidate)) return true
  }
  return false
}

function mappedPlan(lines: Stripe.InvoiceLineItem[], subscriptionId: string, catalog: CatalogEntry[]) {
  const byPrice = new Map(catalog.map((entry) => [entry.priceId, entry]))
  const relevant = lines.filter((line) => lineSubscriptionId(line) === subscriptionId)
  const valueMinor = relevant.reduce((sum, line) => sum + line.amount, 0)
  const positivePlans = new Map<string, CatalogEntry>()
  const negativePlans = new Map<string, CatalogEntry>()
  for (const line of relevant) {
    const mapping = byPrice.get(linePriceId(line) ?? "")
    if (!mapping) continue
    if (line.amount > 0) positivePlans.set(mapping.planId, mapping)
    if (line.amount < 0) negativePlans.set(mapping.planId, mapping)
  }
  const target = positivePlans.size === 1 ? [...positivePlans.values()][0]! : null
  return { valueMinor, target, previous: [...negativePlans.values()] }
}

async function purchaseType(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  customerId: string,
  target: CatalogEntry,
  previous: CatalogEntry[],
): Promise<PurchaseType> {
  if (!await hasEarlierPositiveInvoice(stripe, invoice, customerId)) return "initial_subscription"
  if (invoice.billing_reason === "subscription_cycle") return "renewal"
  if (invoice.billing_reason === "subscription_update" && previous.length === 1
    && previous[0]!.planId !== target.planId && previous[0]!.sortOrder < target.sortOrder) return "upgrade"
  return "other"
}

function finalizedFields(input: {
  purchaseType?: PurchaseType
  currency?: string
  valueMinor?: number
  planId?: string
  validationJson?: string
}) {
  return input
}

export async function deliverInvoicePurchase(
  db: Database,
  stripe: Stripe,
  env: Env,
  webhookInvoice: Stripe.Invoice,
  userId: string,
) {
  if (!await queries.billing.claimPurchaseDelivery(db, webhookInvoice.id, userId)) return

  const skip = async (reason: string, fields = finalizedFields({})) => {
    await queries.billing.finalizePurchaseDelivery(db, webhookInvoice.id, { status: "skipped", reason, ...fields })
  }
  const fail = async (reason: string, fields = finalizedFields({})) => {
    await queries.billing.finalizePurchaseDelivery(db, webhookInvoice.id, { status: "failed", reason, ...fields })
  }

  let invoice: Stripe.Invoice
  try {
    invoice = await stripe.invoices.retrieve(webhookInvoice.id)
    assertStripeMode(env, invoice)
  } catch {
    await fail("invoice_retrieval_failed")
    return
  }
  if (!positivePaidSubscriptionInvoice(invoice)) {
    await skip("invoice_ineligible")
    return
  }
  const subscriptionId = invoiceSubscriptionId(invoice)!
  const customerId = stripeId(invoice.customer)
  if (!customerId || customerId !== stripeId(webhookInvoice.customer)) {
    await fail("invoice_customer_mismatch")
    return
  }

  let lines: Stripe.InvoiceLineItem[]
  let subscription: Stripe.Subscription
  let catalog: CatalogEntry[]
  try {
    [lines, subscription, catalog] = await Promise.all([
      invoiceLines(stripe, invoice.id),
      stripe.subscriptions.retrieve(subscriptionId),
      queries.billing.listPrices(db, true),
    ])
    assertStripeMode(env, subscription)
  } catch {
    await fail("purchase_context_failed")
    return
  }
  if (stripeId(subscription.customer) !== customerId || subscription.metadata.alook_user_id !== userId) {
    await fail("subscription_mismatch")
    return
  }
  const { valueMinor, target, previous } = mappedPlan(lines, subscriptionId, catalog)
  const currency = invoice.currency.toUpperCase()
  const value = stripeAmountToMajorUnit(valueMinor, currency)
  if (!target || !["studio", "house"].includes(target.planId) || value === null || value <= 0) {
    await skip("invoice_items_ineligible", { currency, valueMinor })
    return
  }

  let type: PurchaseType
  try {
    type = await purchaseType(stripe, invoice, customerId, target, previous)
  } catch {
    await fail("purchase_classification_failed", { currency, valueMinor, planId: target.planId })
    return
  }
  const fields = { purchaseType: type, currency, valueMinor, planId: target.planId }
  let consent: Awaited<ReturnType<typeof queries.billing.getAnalyticsConsent>>
  try {
    consent = await queries.billing.getAnalyticsConsent(db, userId)
  } catch {
    await fail("consent_lookup_failed", fields)
    return
  }
  const consentRevision = Number(subscription.metadata[GA4_CONSENT_REVISION_METADATA])
  const clientId = parseGaClientId(`GA1.1.${subscription.metadata[GA4_CLIENT_ID_METADATA] ?? ""}`)
  if (subscription.metadata[GA4_CONSENT_STATUS_METADATA] === "stale_consent_proof") {
    await skip("stale_consent_proof", fields)
    return
  }
  if (consent?.decision === "denied") {
    await skip("consent_revoked", fields)
    return
  }
  if (consent?.decision !== "granted" || !Number.isSafeInteger(consentRevision)
    || consentRevision < 1 || !clientId) {
    await skip("consent_or_identity_unavailable", fields)
    return
  }
  if (consent.revision !== consentRevision) {
    await skip("consent_revision_changed", fields)
    return
  }
  const sessionId = type === "initial_subscription"
    ? parseGaSessionId(`GS1.1.${subscription.metadata[GA4_SESSION_ID_METADATA] ?? ""}`)
    : null
  if (type === "initial_subscription" && !sessionId) {
    await skip("session_identity_invalid", fields)
    return
  }
  if (!env.GA4_API_SECRET) {
    await fail("ga_configuration_missing", fields)
    return
  }

  const params = {
    transaction_id: invoice.id,
    currency,
    value,
    purchase_type: type,
    engagement_time_msec: 1,
    ...(sessionId ? { session_id: Number(sessionId) } : {}),
    items: [{
      item_id: target.planId,
      item_name: PLAN_NAMES[target.planId as keyof typeof PLAN_NAMES],
      price: value,
      quantity: 1,
    }],
  }
  const payload = {
    client_id: clientId,
    consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
    events: [{ name: "purchase", params }],
  }
  const query = new URLSearchParams({ measurement_id: GA4_MEASUREMENT_ID, api_secret: env.GA4_API_SECRET })
  const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }

  try {
    const response = await fetchWithTimeout(`https://www.google-analytics.com/mp/collect?${query}`, request)
    if (!response.ok) {
      await fail(`collection_http_${response.status}`, fields)
      return
    }
  } catch {
    await fail("collection_transport_ambiguous", fields)
    return
  }
  await queries.billing.finalizePurchaseDelivery(db, invoice.id, {
    status: "sent",
    reason: "delivered",
    ...fields,
  })
}
