import { NextResponse, type NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth-policy"
import { optionalAuthPolicy } from "@/lib/middleware/auth"
import { checkRateLimit } from "@/lib/rate-limit"
import { subscribeResendNewsletter } from "@/lib/resend-contacts"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254

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

function resolveClientIp(request: NextRequest): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim()
  if (cfIp) return cfIp
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
  if (forwarded) return forwarded
  return "unknown"
}

type ParsedPayload =
  | { kind: "honeypot" }
  | { kind: "valid"; email: string }
  | { kind: "invalid" }

function parseBody(value: unknown): ParsedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" }
  const record = value as Record<string, unknown>
  if (typeof record.website === "string" && record.website.trim().length > 0) {
    return { kind: "honeypot" }
  }
  if (typeof record.email !== "string") return { kind: "invalid" }
  const normalized = record.email.trim().toLowerCase()
  if (!normalized || normalized.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalized)) {
    return { kind: "invalid" }
  }
  return { kind: "valid", email: normalized }
}

function noStoreJson(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...extraHeaders,
    },
  })
}

export const POST = withAuth(optionalAuthPolicy, async (request, ctx) => {
  if (!sameOriginUrl(request)) {
    return noStoreJson({ error: "Forbidden." }, 403)
  }

  const parsed = parseBody(await request.json().catch(() => null))
  if (parsed.kind === "invalid") {
    return noStoreJson({ error: "Please enter a valid email address." }, 400)
  }
  if (parsed.kind === "honeypot") {
    return noStoreJson({ ok: true, status: "subscribed" }, 200)
  }

  const rateLimit = await checkRateLimit(ctx.env, "newsletter:subscribe", resolveClientIp(request))
  if (!rateLimit.allowed) {
    return noStoreJson(
      { error: "Too many subscription attempts. Please try again later." },
      429,
      { "Retry-After": String(rateLimit.retryAfterSec) },
    )
  }

  const outcome = await subscribeResendNewsletter(ctx.env, parsed.email)
  if (outcome === "unavailable") {
    return noStoreJson({ error: "Newsletter signup is temporarily unavailable." }, 503)
  }
  if (outcome === "failed") {
    return noStoreJson({ error: "Could not complete subscription. Please try again." }, 502)
  }
  return noStoreJson({ ok: true, status: "subscribed" }, 200)
})
