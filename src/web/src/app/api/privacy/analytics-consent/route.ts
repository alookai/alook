import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { withOptionalAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  ANALYTICS_CONSENT_PROOF_COOKIE,
  analyticsConsentCookieValue,
  type AnalyticsConsentDecision,
} from "@/lib/analytics-consent"
import { createAnalyticsConsentProof } from "@/lib/analytics-consent-server"

function sameOriginUrl(request: NextRequest): URL | null {
  const origin = request.headers.get("Origin")
  if (!origin) return null
  try {
    const url = new URL(origin)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || origin !== url.origin) {
      return null
    }
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
    const requestHost = request.headers.get("host")?.trim()
    const expectedHost = forwardedHost || requestHost || request.nextUrl.host
    return expectedHost.toLowerCase() === url.host.toLowerCase() ? url : null
  } catch {
    return null
  }
}

function parseDecision(value: unknown): AnalyticsConsentDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "decision") return null
  const decision = (value as { decision?: unknown }).decision
  return decision === "granted" || decision === "denied" ? decision : null
}

export const POST = withOptionalAuth(async (request, ctx) => {
  const origin = sameOriginUrl(request)
  if (!origin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }
  const decision = parseDecision(await request.json().catch(() => null))
  if (!decision) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 })
  }
  if (!ctx.env.BETTER_AUTH_SECRET) {
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503 })
  }
  const hasSessionCookie = request.cookies.has("better-auth.session_token")
    || request.cookies.has("__Secure-better-auth.session_token")
  if (hasSessionCookie && !ctx.userId) {
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503 })
  }
  const issuedAtMs = Date.now()
  const sourceVersion = Math.floor(issuedAtMs / 1000)
  if (ctx.userId) {
    await queries.billing.recordAnalyticsConsent(getPrimaryDb(ctx.env.DB), ctx.userId, decision, sourceVersion)
  }

  const response = NextResponse.json({ decision })
  const secure = origin.protocol === "https:"
  const shared = {
    path: "/",
    sameSite: "lax" as const,
    secure,
    maxAge: ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  }
  response.cookies.set(
    ANALYTICS_CONSENT_COOKIE,
    analyticsConsentCookieValue(decision),
    shared,
  )
  response.cookies.set(
    ANALYTICS_CONSENT_PROOF_COOKIE,
    await createAnalyticsConsentProof(decision, ctx.env.BETTER_AUTH_SECRET, issuedAtMs),
    { ...shared, httpOnly: true },
  )
  response.headers.set("Cache-Control", "no-store, max-age=0")
  return response
})
