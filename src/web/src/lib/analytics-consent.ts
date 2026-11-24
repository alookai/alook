import { ANALYTICS_ORIGIN, GOOGLE_ADS_TAG_ID } from "./product-analytics-contract"

export const ANALYTICS_CONSENT_COOKIE = "alook_analytics_consent"
export const ANALYTICS_CONSENT_PROOF_COOKIE = "alook_analytics_consent_proof"
export const ANALYTICS_CONSENT_VERSION = "v1"
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180
export const ANALYTICS_CONSENT_CHANGE_EVENT = "alook:analytics-consent-change"
export const GOOGLE_ADS_SIGNUP_FRAME_ID = "alook-ads-signup"

export type AnalyticsConsentDecision = "granted" | "denied"

export const isPublicAnalyticsPath = (path: string) => /^\/(?:download|pricing|contact|privacy|terms|tutorials(?:\/[^/]+)?|usecases(?:\/[^/]+)?|templates(?:\/[^/]+)?|blog(?:\/.*)?)?$/.test(path)

const adsScriptId = "alook-google-ads"
const clickKeys = ["gclid", "gbraid", "wbraid", "gad_source"]
const campaignKeys = ["utm_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_source_platform", "utm_creative_format", "utm_marketing_tactic"]

export function googleCommand(..._args: unknown[]): void {
  window.dataLayer ??= []
  // eslint-disable-next-line prefer-rest-params -- Google commands use dataLayer.push(arguments).
  window.dataLayer.push(arguments)
}

export function publicAnalyticsReferrer(referrer: string, origin: string): string {
  if (!referrer) return ""
  try {
    const url = new URL(referrer)
    return url.origin !== origin || isPublicAnalyticsPath(url.pathname) ? `${url.origin}${url.pathname}` : ""
  } catch { return "" }
}

export function updateGooglePageFields(href: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  try {
    const location = new URL(href, window.location.origin)
    if (location.origin !== window.location.origin) return
    if (!isPublicAnalyticsPath(location.pathname)) {
      if (document.getElementById(adsScriptId)) applyGoogleConsent("denied")
      return
    }
    const safeReferrer = publicAnalyticsReferrer(document.referrer, window.location.origin)
    const pageLocation = new URL(location.pathname, location.origin)
    if (location.origin === ANALYTICS_ORIGIN && readAnalyticsConsent() !== "denied") {
      for (const key of clickKeys) {
        const value = location.searchParams.get(key)
        if (value && /^[a-zA-Z0-9_-]{1,512}$/.test(value)) pageLocation.searchParams.set(key, value)
      }
      for (const key of campaignKeys) {
        const value = location.searchParams.get(key)
        if (value && /^[\p{L}\p{N} _~.+-]{1,128}$/u.test(value)) pageLocation.searchParams.set(key, value)
      }
    }
    googleCommand("set", {
      page_location: pageLocation.href,
      page_referrer: safeReferrer,
    })
  } catch {}
}

export function startGoogleAds(): void {
  if (window.location.origin !== ANALYTICS_ORIGIN || !isPublicAnalyticsPath(window.location.pathname)
    || readAnalyticsConsent() === "denied" || document.getElementById(adsScriptId)) return
  googleCommand("set", "ads_data_redaction", true)
  googleCommand("js", new Date())
  googleCommand("config", GOOGLE_ADS_TAG_ID, {
    groups: "alookAds",
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  })
  const script = document.createElement("script")
  script.id = adsScriptId
  script.async = true
  script.referrerPolicy = "no-referrer"
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_TAG_ID}`
  document.head.appendChild(script)
}

export function bootstrapGoogleAnalytics(): void {
  if (typeof window === "undefined") return
  Object.defineProperty(window, "ga-disable-G-STBCL8F4ZY", {
    configurable: true,
    get: () => window.location.origin !== ANALYTICS_ORIGIN || !isPublicAnalyticsPath(window.location.pathname),
  })
  const decision = window.location.origin === ANALYTICS_ORIGIN && isPublicAnalyticsPath(window.location.pathname)
    ? readAnalyticsConsent() ?? "granted"
    : "denied"
  applyGoogleConsent(decision, "default", decision)
  updateGooglePageFields(window.location.href)
}

export function analyticsConsentCookieValue(decision: AnalyticsConsentDecision): string {
  return `${ANALYTICS_CONSENT_VERSION}.${decision}`
}

export function parseAnalyticsConsentCookie(value: string | null | undefined): AnalyticsConsentDecision | null {
  if (value === analyticsConsentCookieValue("granted")) return "granted"
  if (value === analyticsConsentCookieValue("denied")) return "denied"
  return null
}

export function readAnalyticsConsent(cookieHeader?: string): AnalyticsConsentDecision | null {
  const source = cookieHeader ?? (typeof document === "undefined" ? "" : document.cookie)
  let value: string | null = null
  for (const part of source.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if (name !== ANALYTICS_CONSENT_COOKIE) continue
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return parseAnalyticsConsentCookie(value)
}

export function hasAnalyticsConsent(cookieHeader?: string): boolean {
  return readAnalyticsConsent(cookieHeader) === "granted"
}

export function applyGoogleConsent(
  decision: AnalyticsConsentDecision,
  mode: "default" | "update" = "update",
  adsDecision: AnalyticsConsentDecision = "denied",
): void {
  if (typeof window === "undefined") return
  googleCommand("consent", mode, {
    analytics_storage: decision,
    ad_storage: adsDecision,
    ad_user_data: adsDecision,
    ad_personalization: "denied",
  })
}

let pendingConsentSave = Promise.resolve()

export function persistAnalyticsConsent(decision: AnalyticsConsentDecision): Promise<void> {
  const save = pendingConsentSave.then(async () => {
    const response = await fetch("/api/privacy/analytics-consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    })
    const body = await response.json().catch(() => null) as { decision?: unknown } | null
    if (!response.ok || body?.decision !== decision) throw new Error("analytics consent was not saved")
  })
  pendingConsentSave = save.catch(() => {})
  return save
}

export function announceAnalyticsConsent(decision: AnalyticsConsentDecision): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<AnalyticsConsentDecision>(
    ANALYTICS_CONSENT_CHANGE_EVENT,
    { detail: decision },
  ))
}
