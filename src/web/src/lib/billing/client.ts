import Stripe from "stripe"
import { NextResponse } from "next/server"

export class BillingError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code)
  }
}

export function billingClient(env: Env) {
  if (!env.STRIPE_SECRET_KEY) throw new BillingError("BILLING_UNAVAILABLE", 503)
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-08-26.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20_000,
  })
}

export function assertStripeMode(env: Env, object: { livemode: boolean }) {
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "")
  if (object.livemode !== live) throw new BillingError("BILLING_ENVIRONMENT_MISMATCH", 503)
}

export function billingOrigin(env: Env) {
  const url = new URL(env.STRIPE_RETURN_ORIGIN ?? env.BETTER_AUTH_URL)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new BillingError("BILLING_UNAVAILABLE", 503)
  }
  return url.origin
}

export function billingResponse(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } })
}

export function billingFailure(error: unknown, operation: string = "billing") {
  if (!(error instanceof BillingError)) {
    const detail = error as { name?: string; type?: string; code?: string; requestId?: string; statusCode?: number; cause?: { code?: string; name?: string } } | null
    console.error("billing_request_failed", {
      operation, name: detail?.name, type: detail?.type, code: detail?.code,
      status: detail?.statusCode, requestId: detail?.requestId,
      causeName: detail?.cause?.name, causeCode: detail?.cause?.code,
    })
  }
  return error instanceof BillingError
    ? billingResponse({ error: error.code }, error.status)
    : billingResponse({ error: "BILLING_UNAVAILABLE" }, 503)
}

export function stripeId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null
}
