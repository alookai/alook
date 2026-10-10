export const ANALYTICS_CONSENT_COOKIE = "alook_analytics_consent"
export const ANALYTICS_CONSENT_PROOF_COOKIE = "alook_analytics_consent_proof"
export const ANALYTICS_CONSENT_VERSION = "v1"
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180
export const ANALYTICS_CONSENT_CHANGE_EVENT = "alook:analytics-consent-change"

export type AnalyticsConsentDecision = "granted" | "denied"

export const isPublicAnalyticsPath = (path: string) => /^\/(?:pricing|contact|privacy|templates(?:\/[^/]+)?|blog(?:\/.*)?)?$/.test(path)

function googleCommand(..._args: unknown[]): void {
  window.dataLayer ??= []
  // eslint-disable-next-line prefer-rest-params -- Google commands use dataLayer.push(arguments).
  window.dataLayer.push(arguments)
}

export function updateGooglePageFields(href: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  try {
    const location = new URL(href, window.location.origin)
    if (location.origin !== window.location.origin || !isPublicAnalyticsPath(location.pathname)) return
    let safeReferrer = ""
    try {
      const referrer = new URL(document.referrer || window.location.origin)
      if (referrer.origin !== window.location.origin || isPublicAnalyticsPath(referrer.pathname)) {
        safeReferrer = `${referrer.origin}${referrer.pathname}`
      }
    } catch {}
    googleCommand("set", {
      page_location: `${location.origin}${location.pathname}`,
      page_referrer: safeReferrer,
    })
  } catch {}
}

export function bootstrapGoogleAnalytics(): void {
  if (typeof window === "undefined") return
  Object.defineProperty(window, "ga-disable-G-STBCL8F4ZY", {
    configurable: true,
    get: () => !isPublicAnalyticsPath(window.location.pathname),
  })
  applyGoogleConsent(readAnalyticsConsent() ?? "denied", "default")
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
): void {
  if (typeof window === "undefined") return
  googleCommand("consent", mode, {
    analytics_storage: decision,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  })
}

export async function persistAnalyticsConsent(decision: AnalyticsConsentDecision): Promise<void> {
  const response = await fetch("/api/privacy/analytics-consent", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  })
  const body = await response.json().catch(() => null) as { decision?: unknown } | null
  if (!response.ok || body?.decision !== decision) throw new Error("analytics consent was not saved")
}

export function announceAnalyticsConsent(decision: AnalyticsConsentDecision): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<AnalyticsConsentDecision>(
    ANALYTICS_CONSENT_CHANGE_EVENT,
    { detail: decision },
  ))
}
