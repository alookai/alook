import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createLogger, queries, type Database, type ProductAnalyticsEvent, type ProductAnalyticsEventName } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { readAnalyticsConsent, ANALYTICS_CONSENT_MAX_AGE_SECONDS, ANALYTICS_CONSENT_PROOF_COOKIE } from "@/lib/analytics-consent"
import { GA4_MEASUREMENT_ID, parseGaClientId, parseGaSessionId, verifyAnalyticsConsentProof } from "@/lib/analytics-consent-server"

const PRODUCT_SESSION_COOKIE = "alook_product_analytics_session"
const log = createLogger({ service: "product-analytics" })
const idleSeconds = 30 * 60

function analyticsCookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try { return decodeURIComponent(part.slice(separator + 1).trim()) } catch { return null }
  }
  return null
}

export async function productAnalyticsAllowed(db: Database, env: Env, cookies: string, actorUserId?: string) {
  if (readAnalyticsConsent(cookies) === "denied") return false
  const proof = analyticsCookieValue(cookies, ANALYTICS_CONSENT_PROOF_COOKIE)
  if (proof) {
    if (!env.BETTER_AUTH_SECRET) return false
    const verified = await verifyAnalyticsConsentProof(proof, env.BETTER_AUTH_SECRET)
    if (!verified || verified.decision === "denied") return false
  }
  if (actorUserId && (await queries.billing.getAnalyticsConsent(db, actorUserId))?.decision === "denied") return false
  return true
}

export function productAnalyticsMeasurementId(env: Env) {
  const development = (env.NODE_ENV ?? process.env.NODE_ENV) === "development"
  return development && /^G-[A-Z0-9]+$/u.test(env.DEV_PRODUCT_ANALYTICS_MEASUREMENT_ID ?? "")
    ? env.DEV_PRODUCT_ANALYTICS_MEASUREMENT_ID! : GA4_MEASUREMENT_ID
}

export function productAnalyticsIdentity(cookies: string, nowMs = Date.now(), measurementId = GA4_MEASUREMENT_ID) {
  const now = Math.floor(nowMs / 1000)
  const currentClient = parseGaClientId(analyticsCookieValue(cookies, "_ga"))
  const random = crypto.getRandomValues(new Uint32Array(2))
  const clientId = currentClient ?? `${random[0]}.${random[1]}`
  const gaCookie = analyticsCookieValue(cookies, `_ga_${measurementId.slice(2).replaceAll("-", "_")}`)
  const gaSession = parseGaSessionId(gaCookie)
  const gaLastActive = gaCookie?.startsWith("GS2.")
    ? Number(/(?:\.|\$)t(\d+)(?:\$|$)/u.exec(gaCookie)?.[1]) : Number(gaCookie?.split(".")[5])
  const fallback = analyticsCookieValue(cookies, PRODUCT_SESSION_COOKIE)?.split(".") ?? []
  const recent = (session: string | null | undefined, active: number) => Boolean(session && /^\d{1,20}$/u.test(session)
    && Number.isSafeInteger(Number(session)) && Number(session) > 0 && Number(session) <= now
    && now - Number(session) < 24 * 60 * 60 && Number.isSafeInteger(active)
    && active >= Number(session) && active <= now && now - active < idleSeconds)
  const sessionId = currentClient && recent(gaSession, gaLastActive) ? gaSession!
    : currentClient && recent(fallback[0], Number(fallback[1])) ? fallback[0] : String(now)
  return { clientId, sessionId, sessionCookie: `${sessionId}.${now}`, needsClientCookie: !currentClient }
}

async function pseudonymousUserId(secret: string, actorUserId: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`product-analytics-user:${actorUserId}`))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function productAnalyticsPayload(event: ProductAnalyticsEvent, secret: string) {
  const definitions: Record<ProductAnalyticsEventName, string> = {
    landing_cta_clicked: "public_entry_click", login_page_view: "login_page_entry",
    sign_up: "account_committed", sign_in_success: "session_committed", sign_in_failed: "login_step_failed",
    onboarding_enter_clicked: "enter_my_room_click", onboarding_first_message: "first_committed_human_message",
    invitation_link_visit: "invited_visitor_page_entry",
  }
  const path = event.eventName === "invitation_link_visit" ? "/analytics/invitation"
    : event.eventName === "landing_cta_clicked" ? "/" : ["login_page_view", "sign_up", "sign_in_success", "sign_in_failed"].includes(event.eventName)
      ? "/sign-in" : "/analytics/onboarding"
  return {
    client_id: event.clientId,
    ...(event.actorUserId ? { user_id: await pseudonymousUserId(secret, event.actorUserId) } : {}),
    timestamp_micros: Date.parse(event.createdAt) * 1000,
    consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
    events: [{ name: event.eventName, params: {
      session_id: Number(event.sessionId), measurement_definition: definitions[event.eventName],
      page_location: `https://alook.ai${path}`,
      ...(event.method ? { method: event.method } : {}),
      ...(event.accountKind ? { account_kind: event.accountKind } : {}),
      ...(event.ctaName ? { cta_name: event.ctaName } : {}),
      ...(event.failureStage ? { failure_stage: event.failureStage } : {}),
    } }],
  }
}

function collectionUrl(env: Env) {
  const query = new URLSearchParams({ measurement_id: productAnalyticsMeasurementId(env), api_secret: env.GA4_API_SECRET! })
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === "development" && env.DEV_PRODUCT_ANALYTICS_COLLECTOR) {
    const url = new URL(env.DEV_PRODUCT_ANALYTICS_COLLECTOR)
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.hash || url.search) throw new Error("invalid local collector")
    url.search = query.toString()
    return url.toString()
  }
  return `https://www.google-analytics.com/mp/collect?${query}`
}

export async function deliverProductAnalytics(db: Database, env: Env, event: ProductAnalyticsEvent) {
  if (!env.GA4_API_SECRET || !env.BETTER_AUTH_SECRET) {
    await queries.productAnalytics.notePendingReason(db, event.id, "configuration_missing")
    return "configuration_missing"
  }
  const claimed = await queries.productAnalytics.claimDelivery(db, event.id)
  if (!claimed) return "already_claimed"
  try {
    if (claimed.actorUserId && (await queries.billing.getAnalyticsConsent(db, claimed.actorUserId))?.decision === "denied") {
      await queries.productAnalytics.finishDelivery(db, claimed.id, "denied", "consent_revoked")
      return "denied"
    }
    let url: string
    try { url = collectionUrl(env) } catch {
      await queries.productAnalytics.finishDelivery(db, claimed.id, "failed", "collector_configuration_invalid")
      return "configuration_invalid"
    }
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await productAnalyticsPayload(claimed, env.BETTER_AUTH_SECRET)),
      signal: AbortSignal.timeout(2500),
    })
    await queries.productAnalytics.finishDelivery(db, claimed.id, response.ok ? "accepted" : "failed",
      response.ok ? "http_accepted" : `collection_http_${response.status}`)
    return response.ok ? "http_accepted" : "http_failed"
  } catch {
    await queries.productAnalytics.finishDelivery(db, claimed.id, "uncertain", "collection_transport_ambiguous")
    return "uncertain"
  }
}

export async function scheduleProductAnalytics(work: () => Promise<unknown>) {
  try {
    const { ctx } = await getCloudflareContext({ async: true })
    ctx.waitUntil(work().catch(() => { log.warn("analytics background operation failed") }))
  } catch { log.warn("analytics execution context unavailable") }
}

export async function captureOnboardingFirstMessage(db: Database, env: Env, actorUserId: string, serverId: string, cookies: string, messageId: string) {
  if (!parseGaClientId(analyticsCookieValue(cookies, "_ga")) || !await productAnalyticsAllowed(db, env, cookies, actorUserId)) return
  const identity = productAnalyticsIdentity(cookies, Date.now(), productAnalyticsMeasurementId(env))
  const event = await queries.productAnalytics.recordFirstHumanMessage(db, actorUserId, serverId, identity, messageId)
  if (!event?.inserted) return
  await scheduleProductAnalytics(() => deliverProductAnalytics(db, env, event.row))
  return identity
}

export async function setOnboardingFirstMessageCookies(response: { cookies: { set: Parameters<typeof setProductAnalyticsCookies>[0] } }, db: Database, env: Env, actorUserId: string, serverId: string, cookies: string, messageId: string) {
  try {
    const identity = await captureOnboardingFirstMessage(db, env, actorUserId, serverId, cookies, messageId)
    if (identity) setProductAnalyticsCookies((...args) => response.cookies.set(...args), identity, env.BETTER_AUTH_URL?.startsWith("https:") ?? false)
  } catch { log.warn("first-message analytics capture failed") }
}

export function webAuthenticationMethod(path: string): string | null {
  if (path.endsWith("/sign-in/email-otp")) return "email_otp"
  const provider = /\/(?:callback|oauth2\/callback)\/(github|google|apple)$/u.exec(path)?.[1]
  if (provider) return provider
  if (process.env.NODE_ENV !== "production" && /\/(?:sign-in|sign-up)\/email$/u.test(path)) return "development_password"
  return null
}

export async function captureAuthentication(env: Env, input: {
  actorUserId: string; sessionId?: string; cookies: string; path: string; nativeFlow?: boolean; createdAt: Date;
}) {
  const method = webAuthenticationMethod(input.path)
  if (!method || input.nativeFlow) return
  const db = getPrimaryDb(env.DB)
  if (!await productAnalyticsAllowed(db, env, input.cookies, input.actorUserId)) return
  const identity = productAnalyticsIdentity(input.cookies, input.createdAt.getTime(), productAnalyticsMeasurementId(env))
  const accountKind = input.sessionId
    ? await queries.productAnalytics.claimSignupSession(db, input.actorUserId, input.sessionId) ? "new" : "existing"
    : "new"
  const event = await queries.productAnalytics.recordEvent(db, {
    eventName: input.sessionId ? "sign_in_success" : "sign_up", actorUserId: input.actorUserId,
    sourceId: input.sessionId ?? null, dedupeKey: input.sessionId ? `auth-session:${input.sessionId}` : `signup:${input.actorUserId}`,
    clientId: identity.clientId, sessionId: identity.sessionId, createdAt: input.createdAt.toISOString(), method, accountKind,
  })
  if (event) await scheduleProductAnalytics(() => deliverProductAnalytics(db, env, event.row))
  return identity
}

export async function captureOAuthCallbackFailure(env: Env, input: { method: "github" | "google" | "apple"; attemptId: string; cookies: string; actorUserId?: string }) {
  const db = getPrimaryDb(env.DB)
  if (!await productAnalyticsAllowed(db, env, input.cookies, input.actorUserId)) return
  const identity = productAnalyticsIdentity(input.cookies, Date.now(), productAnalyticsMeasurementId(env))
  const event = await queries.productAnalytics.recordEvent(db, {
    eventName: "sign_in_failed", actorUserId: input.actorUserId, sourceId: input.attemptId, dedupeKey: `oauth-callback-failed:${input.attemptId}`,
    clientId: identity.clientId, sessionId: identity.sessionId, createdAt: new Date().toISOString(),
    method: input.method, failureStage: "provider_callback",
  })
  if (!event?.inserted) return
  await scheduleProductAnalytics(() => deliverProductAnalytics(db, env, event.row))
  return identity
}

export function setProductAnalyticsCookies(
  setCookie: (name: string, value: string, options: { path: string; sameSite: "lax"; secure: boolean; maxAge: number; httpOnly?: boolean }) => unknown,
  identity: ReturnType<typeof productAnalyticsIdentity>, secure: boolean,
) {
  const options = { path: "/", sameSite: "lax" as const, secure, maxAge: idleSeconds, httpOnly: true }
  setCookie(PRODUCT_SESSION_COOKIE, identity.sessionCookie, options)
  if (identity.needsClientCookie) setCookie("_ga", `GA1.1.${identity.clientId}`, { ...options, httpOnly: false, maxAge: ANALYTICS_CONSENT_MAX_AGE_SECONDS })
}

export function analyticsCookiesAfterResponse(cookies: string, responseCookies: string[]) {
  const values = new Map(cookies.split(";").map(part => { const i = part.indexOf("="); return [part.slice(0, i).trim(), part.slice(i + 1)] }))
  for (const cookie of responseCookies) {
    const pair = cookie.split(";", 1)[0]
    const i = pair.indexOf("=")
    const name = pair.slice(0, i)
    if (name === "_ga" || name === PRODUCT_SESSION_COOKIE) values.set(name, pair.slice(i + 1))
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ")
}
