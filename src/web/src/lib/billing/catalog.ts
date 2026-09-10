import { BillingOfferSchema, PublicPricingSchema, queries, type Database } from "@alook/shared"
import type Stripe from "stripe"
import { assertStripeMode, BillingError } from "./client"

type Mapping = Awaited<ReturnType<typeof queries.billing.listPrices>>[number]

export async function getCatalog(db: Database) {
  return queries.billing.listPrices(db, true)
}

async function offerFor(stripe: Stripe, env: Env, mapping: Mapping) {
  const price = await stripe.prices.retrieve(mapping.priceId, { expand: ["product"] })
  assertStripeMode(env, price)
  const product = price.product
  if (!price.active || !price.recurring || price.type !== "recurring" || price.unit_amount === null
    || typeof product === "string" || product.deleted || !product.active) return null
  return BillingOfferSchema.parse({
    priceId: price.id,
    plan: { id: mapping.planId, displayName: mapping.displayName },
    botLimit: mapping.botLimit,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring.interval,
    intervalCount: price.recurring.interval_count,
  })
}

export async function getOffers(db: Database, stripe: Stripe, env: Env) {
  const mappings = await queries.billing.listPrices(db)
  const offers = await Promise.all(mappings.map((mapping) => offerFor(stripe, env, mapping)))
  return offers.filter((offer) => offer !== null)
}

export async function getPublicPricing(db: Database, stripe: Stripe, env: Env) {
  const [free, offers] = await Promise.all([
    queries.billing.getDefaultPlanOffer(db),
    getOffers(db, stripe, env),
  ])
  return PublicPricingSchema.parse({ free, offers })
}

export async function requireOffer(db: Database, stripe: Stripe, env: Env, priceId: string) {
  const mapping = (await queries.billing.listPrices(db)).find((item) => item.priceId === priceId)
  const offer = mapping ? await offerFor(stripe, env, mapping) : null
  if (!offer) throw new BillingError("BILLING_PRICE_UNAVAILABLE", 400)
  return offer
}
