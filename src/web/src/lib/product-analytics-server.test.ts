import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Database, ProductAnalyticsEvent } from "@alook/shared"
import { createAnalyticsConsentProof } from "./analytics-consent-server"

const mocks = vi.hoisted(() => ({ consent: vi.fn(), claim: vi.fn(), finish: vi.fn(), note: vi.fn(), first: vi.fn(), record: vi.fn(), signup: vi.fn(), waitUntil: vi.fn(), context: vi.fn() }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  billing: { getAnalyticsConsent: mocks.consent }, productAnalytics: { claimDelivery: mocks.claim, finishDelivery: mocks.finish,
    notePendingReason: mocks.note, recordFirstHumanMessage: mocks.first, recordEvent: mocks.record, claimSignupSession: mocks.signup },
} }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.context }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
import { analyticsCookiesAfterResponse, captureAuthentication, captureOAuthCallbackFailure, captureOnboardingFirstMessage, deliverProductAnalytics, productAnalyticsAllowed,
  productAnalyticsIdentity, productAnalyticsMeasurementId, productAnalyticsPayload, setProductAnalyticsCookies, setOnboardingFirstMessageCookies, webAuthenticationMethod } from "./product-analytics-server"

const db = {} as Database
const env = { BETTER_AUTH_SECRET: "fixture-auth-secret", GA4_API_SECRET: "fixture-only", NODE_ENV: "development", DEV_PRODUCT_ANALYTICS_COLLECTOR: "http://127.0.0.1:3345/collect" } as Env
const event: ProductAnalyticsEvent = { id: "event", actorUserId: "private-user", serverId: "private-server", sourceId: "private-token",
  eventName: "onboarding_enter_clicked", clientId: "100.200", sessionId: "1791781200", createdAt: "2026-10-12T05:00:00.000Z",
  dedupeKey: "private-dedupe", deliveryStatus: "pending", deliveryReason: null, attemptedAt: null, method: null, accountKind: null, ctaName: null, failureStage: null }
const cookies = "_ga=GA1.1.100.200; alook_product_analytics_session=1791781200.1791781220"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.context.mockResolvedValue({ ctx: { waitUntil: mocks.waitUntil } })
  mocks.consent.mockResolvedValue(null)
  mocks.claim.mockResolvedValue(event)
  mocks.record.mockResolvedValue({ row: event, inserted: true })
  mocks.first.mockResolvedValue({ row: event, inserted: true })
  mocks.signup.mockResolvedValue(true)
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe("product analytics server boundaries", () => {
  it("defaults absent choice to allowed but respects browser and account denial", async () => {
    expect(await productAnalyticsAllowed(db, env, "")).toBe(true)
    expect(await productAnalyticsAllowed(db, env, "alook_analytics_consent=v1.denied")).toBe(false)
    mocks.consent.mockResolvedValue({ decision: "denied" })
    expect(await productAnalyticsAllowed(db, env, "", "owner")).toBe(false)
  })
  it("rejects invalid or signed denied proof and accepts signed granted proof", async () => {
    expect(await productAnalyticsAllowed(db, env, "alook_analytics_consent_proof=invalid")).toBe(false)
    for (const decision of ["denied", "granted"] as const) {
      const proof = await createAnalyticsConsentProof(decision, env.BETTER_AUTH_SECRET)
      expect(await productAnalyticsAllowed(db, env, `alook_analytics_consent_proof=${proof}`)).toBe(decision === "granted")
    }
  })
  it("reuses fresh GS2 and GS1 public sessions and client id", () => {
    const now = 1791781230000
    expect(productAnalyticsIdentity("_ga=GA1.1.100.200; _ga_STBCL8F4ZY=GS2.1.s1791781200$o1$g1$t1791781220$j0", now)).toMatchObject(identity("1791781200"))
    expect(productAnalyticsIdentity("_ga=GA1.1.100.200; _ga_STBCL8F4ZY=GS1.1.1791781200.1.1.1791781220.0.0.0", now)).toMatchObject(identity("1791781200"))
  })
  it("expires idle, future and more-than-24h sessions while preserving browser identity", () => {
    for (const value of ["1791781200.1791781220", "1792040401.1792040401", "1.1792040399"]) {
      expect(productAnalyticsIdentity(`_ga=GA1.1.100.200; alook_product_analytics_session=${value}`, 1792040400000)).toMatchObject(identity("1792040400"))
    }
  })
  it("creates a random client for fresh visitors and persists fallback identity", () => {
    const value = productAnalyticsIdentity("", 1791781230000)
    expect(value.clientId).toMatch(/^\d+\.\d+$/u)
    const set = vi.fn()
    setProductAnalyticsCookies(set, value, true)
    expect(set).toHaveBeenCalledWith("_ga", `GA1.1.${value.clientId}`, expect.objectContaining({ httpOnly: false, secure: true }))
    expect(set).toHaveBeenCalledWith("alook_product_analytics_session", "1791781230.1791781230", expect.objectContaining({ httpOnly: true }))
  })
  it("joins new account and session through response cookies without trusting signup UI cookies", () => {
    expect(analyticsCookiesAfterResponse("_ga=GA1.1.1.2; is_new_signup=forged", ["_ga=GA1.1.100.200; Path=/", "alook_product_analytics_session=1791781200.1791781220; HttpOnly", "secret-session=not-copied; HttpOnly"]))
      .toBe("_ga=GA1.1.100.200; is_new_signup=forged; alook_product_analytics_session=1791781200.1791781220")
  })
  it("emits only sanitized dimensions and pseudonymous account identity, without fabricated engagement", async () => {
    const payload = await productAnalyticsPayload(event, env.BETTER_AUTH_SECRET)
    expect(payload.user_id).toMatch(/^[a-f0-9]{64}$/u)
    expect(payload.events[0].params).toEqual({ session_id: 1791781200, measurement_definition: "enter_my_room_click", page_location: "https://alook.ai/analytics/onboarding" })
    expect(JSON.stringify(payload)).not.toContain("private-")
    expect(JSON.stringify(payload)).not.toContain("engagement_time")
  })
  it("keeps missing credentials explicit and performs no transport", async () => {
    expect(await deliverProductAnalytics(db, { ...env, GA4_API_SECRET: undefined }, event)).toBe("configuration_missing")
    expect(mocks.note).toHaveBeenCalledWith(db, "event", "configuration_missing")
    expect(fetch).not.toHaveBeenCalled()
  })
  it("sends once to the local collector and records HTTP acceptance only", async () => {
    expect(await deliverProductAnalytics(db, env, event)).toBe("http_accepted")
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("http://127.0.0.1:3345/collect?")
    expect(mocks.finish).toHaveBeenCalledWith(db, "event", "accepted", "http_accepted")
    mocks.claim.mockResolvedValue(null)
    expect(await deliverProductAnalytics(db, env, event)).toBe("already_claimed")
    expect(fetch).toHaveBeenCalledOnce()
  })
  it("rechecks account denial before dispatch", async () => {
    mocks.consent.mockResolvedValue({ decision: "denied" })
    expect(await deliverProductAnalytics(db, env, event)).toBe("denied")
    expect(fetch).not.toHaveBeenCalled()
  })
  it("records non2xx as failure and network ambiguity without automatic retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 403 }))
    expect(await deliverProductAnalytics(db, env, event)).toBe("http_failed")
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"))
    expect(await deliverProductAnalytics(db, env, event)).toBe("uncertain")
    expect(mocks.finish).toHaveBeenLastCalledWith(db, "event", "uncertain", "collection_transport_ambiguous")
  })
  it("rejects non-loopback development collectors", async () => {
    for (const collector of ["https://127.0.0.1/collect", "http://example.com/collect", "http://127.0.0.1/collect?extra=1", "http://user@127.0.0.1/collect"]) {
      expect(await deliverProductAnalytics(db, { ...env, DEV_PRODUCT_ANALYTICS_COLLECTOR: collector }, event)).toBe("configuration_invalid")
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it("isolates the test measurement target and ignores development overrides in production", async () => {
    const test = { ...env, DEV_PRODUCT_ANALYTICS_MEASUREMENT_ID: "G-TEST123" }
    expect(productAnalyticsMeasurementId(test)).toBe("G-TEST123")
    expect(productAnalyticsMeasurementId({ ...test, NODE_ENV: "production" })).toBe("G-STBCL8F4ZY")
    await deliverProductAnalytics(db, { ...test, NODE_ENV: "production" }, event)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("https://www.google-analytics.com/mp/collect?measurement_id=G-STBCL8F4ZY")
  })
  it("passes current request denial to first-message capture after anonymous rejection", async () => {
    await captureOnboardingFirstMessage(db, env, "private-user", "private-server", `${cookies}; alook_analytics_consent=v1.denied`, "first")
    expect(mocks.first).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("passes current identity into the durable human-message query", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1791781230000)
    await captureOnboardingFirstMessage(db, env, "private-user", "private-server", cookies, "first")
    expect(mocks.first).toHaveBeenCalledWith(db, "private-user", "private-server", expect.objectContaining(identity("1791781200")), "first")
  })
  it("returns a new late session in the eligible human response without waiting for collection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1792040400000)
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const response = { cookies: { set: vi.fn() } }
    await setOnboardingFirstMessageCookies(response, db, env, "owner", "server", cookies, "first")
    expect(mocks.first).toHaveBeenCalledWith(db, "owner", "server", expect.objectContaining(identity("1792040400")), "first")
    expect(response.cookies.set).toHaveBeenCalledWith("alook_product_analytics_session", "1792040400.1792040400", expect.objectContaining({ httpOnly: true }))
    expect(mocks.waitUntil).toHaveBeenCalledOnce()
    expect(productAnalyticsIdentity(analyticsCookiesAfterResponse(cookies, ["alook_product_analytics_session=1792040400.1792040400; HttpOnly"]), 1792040405000).sessionId).toBe("1792040400")
  })
  it("does not change response cookies for ineligible or duplicate first-message records", async () => {
    const response = { cookies: { set: vi.fn() } }
    for (const result of [null, { row: event, inserted: false }]) {
      mocks.first.mockResolvedValueOnce(result)
      await setOnboardingFirstMessageCookies(response, db, env, "owner", "server", cookies, "later")
    }
    expect(response.cookies.set).not.toHaveBeenCalled()
    expect(mocks.waitUntil).not.toHaveBeenCalled()
  })
  it("preserves an eligible human response when background execution context is unavailable", async () => {
    mocks.context.mockRejectedValueOnce(new Error("context unavailable"))
    const response = { cookies: { set: vi.fn() } }
    await expect(setOnboardingFirstMessageCookies(response, db, env, "owner", "server", cookies, "first")).resolves.toBeUndefined()
    expect(response.cookies.set).toHaveBeenCalledWith("alook_product_analytics_session", expect.any(String), expect.objectContaining({ httpOnly: true }))
    expect(mocks.waitUntil).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("isolates first-message ledger errors from the committed human response", async () => {
    mocks.first.mockRejectedValueOnce(new Error("database unavailable"))
    const response = { cookies: { set: vi.fn() } }
    await expect(setOnboardingFirstMessageCookies(response, db, env, "owner", "server", cookies, "first")).resolves.toBeUndefined()
    expect(response.cookies.set).not.toHaveBeenCalled()
  })
  it("records bounded callback failures without exporting the state or provider error", async () => {
    await captureOAuthCallbackFailure(env, { method: "github", attemptId: "private-attempt", cookies })
    expect(mocks.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      eventName: "sign_in_failed", method: "github", failureStage: "provider_callback", sourceId: "private-attempt",
    }))
    const input = mocks.record.mock.calls.at(-1)![1]
    const payload = await productAnalyticsPayload({ ...event, ...input }, env.BETTER_AUTH_SECRET)
    expect(payload.events[0].params).toMatchObject({ method: "github", failure_stage: "provider_callback" })
    expect(JSON.stringify(payload)).not.toContain("private-attempt")
  })
  it("suppresses denied and duplicate OAuth failure delivery and cookie updates", async () => {
    expect(await captureOAuthCallbackFailure(env, { method: "github", attemptId: "attempt", cookies: `${cookies}; alook_analytics_consent=v1.denied` })).toBeUndefined()
    expect(mocks.record).not.toHaveBeenCalled()
    mocks.record.mockResolvedValueOnce({ row: event, inserted: false })
    expect(await captureOAuthCallbackFailure(env, { method: "github", attemptId: "attempt", cookies })).toBeUndefined()
    expect(mocks.waitUntil).not.toHaveBeenCalled()
  })
  it("rechecks primary denial for an identified account before OAuth failure capture", async () => {
    mocks.consent.mockResolvedValue({ decision: "denied" })
    expect(await captureOAuthCallbackFailure(env, { method: "github", attemptId: "attempt", cookies, actorUserId: "owner" })).toBeUndefined()
    expect(mocks.consent).toHaveBeenCalledWith(expect.anything(), "owner")
    expect(mocks.record).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("records real auth outcomes from durable registration/session association", async () => {
    const input = { actorUserId: "private-user", cookies, path: "/api/auth/sign-in/email-otp", createdAt: new Date(event.createdAt) }
    await captureAuthentication(env, input)
    expect(mocks.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ eventName: "sign_up", accountKind: "new", method: "email_otp" }))
    await captureAuthentication(env, { ...input, sessionId: "real-session" })
    expect(mocks.signup).toHaveBeenCalledWith(expect.anything(), "private-user", "real-session")
    expect(mocks.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ eventName: "sign_in_success", accountKind: "new", sourceId: "real-session" }))
    mocks.signup.mockResolvedValue(false)
    await captureAuthentication(env, { ...input, sessionId: "next-session" })
    expect(mocks.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ accountKind: "existing" }))
  })
  it("excludes native provider handoffs from web authentication metrics", async () => {
    await captureAuthentication(env, { actorUserId: "owner", cookies, nativeFlow: true, path: "/api/auth/callback/github", createdAt: new Date() })
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("ignores OTP send, social redirect start, device and native exchange as login success", () => {
    for (const path of ["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/social", "/api/auth/device/token", "/api/auth/one-time-token/verify", "/api/auth/native/exchange"]) expect(webAuthenticationMethod(path)).toBeNull()
    for (const provider of ["github", "google", "apple"]) expect(webAuthenticationMethod(`/api/auth/callback/${provider}`)).toBe(provider)
  })
})
function identity(sessionId: string) { return { clientId: "100.200", sessionId, needsClientCookie: false } }
