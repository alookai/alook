import { isTauri } from "@alook/shared"

export const ANALYTICS_CONSENT_COOKIE = "alook_analytics_consent"
export const ANALYTICS_CONSENT_PROOF_COOKIE = "alook_analytics_consent_proof"
export const ANALYTICS_CONSENT_VERSION = "v1"
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180
export const ANALYTICS_CONSENT_CHANGE_EVENT = "alook:analytics-consent-change"

export type AnalyticsConsentDecision = "granted" | "denied"

export const isPublicAnalyticsPath = (path: string) => /^\/(?:pricing|contact|privacy|templates(?:\/[^/]+)?|blog(?:\/.*)?)?$/.test(path)

const CONSENT_CHANNEL = "alook:analytics-consent"
const CONSENT_INVALIDATION = "analytics-consent-invalidated"

type AnalyticsDocumentLifecycle = {
  browser: Window
  document: Document
  active: boolean
  observers: number
  decision: AnalyticsConsentDecision | null
  publicGrant: boolean
  startupLocked: boolean
  replacementRequested: boolean
  googleUpdated: boolean
  pendingSaves: number
  channel?: BroadcastChannel
  openChannel: () => void
  dispose: () => void
}

let analyticsDocument: AnalyticsDocumentLifecycle | undefined

function refreshDocumentConsent(
  state: AnalyticsDocumentLifecycle,
  { syncGoogle = false, restored = false, replace = true } = {},
): AnalyticsConsentDecision | null {
  if (!state.active) return readAnalyticsConsent()
  const next = readAnalyticsConsent()
  const publicPath = isPublicAnalyticsPath(state.browser.location.pathname)
  const wasLocked = state.startupLocked
  if (state.publicGrant && (restored || next !== "granted" || !publicPath)) {
    state.startupLocked = true
  }
  if (next === "granted" && publicPath && !state.startupLocked) state.publicGrant = true
  const changed = next !== state.decision
  state.decision = next
  if (changed || syncGoogle && !state.googleUpdated) {
    state.googleUpdated = true
    applyGoogleConsent(next ?? "denied")
  }
  if (changed || wasLocked !== state.startupLocked) announceAnalyticsConsent(next ?? "denied")
  if (replace && state.startupLocked && state.pendingSaves === 0 && !state.replacementRequested) {
    state.replacementRequested = true
    state.browser.location.reload()
  }
  return next
}

function currentAnalyticsDocument(): AnalyticsDocumentLifecycle | undefined {
  if (typeof window === "undefined" || typeof document === "undefined" || isTauri()
    || typeof window.addEventListener !== "function") return
  if (analyticsDocument?.browser === window && analyticsDocument.document === document) return analyticsDocument
  analyticsDocument?.dispose()
  const decision = readAnalyticsConsent()
  const state: AnalyticsDocumentLifecycle = {
    browser: window,
    document,
    active: true,
    observers: 0,
    decision,
    publicGrant: decision === "granted" && isPublicAnalyticsPath(window.location.pathname),
    startupLocked: false,
    replacementRequested: false,
    googleUpdated: false,
    pendingSaves: 0,
    openChannel: () => {
      if (state.channel) return
      try {
        const channel = new window.BroadcastChannel(CONSENT_CHANNEL)
        channel.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.kind === CONSENT_INVALIDATION) refreshDocumentConsent(state)
        })
        state.channel = channel
      } catch {}
    },
    dispose: () => {
      state.active = false
      state.channel?.close()
      state.channel = undefined
      cookieStore?.removeEventListener("change", onCookieChange)
      state.browser.removeEventListener("focus", onResume)
      state.browser.removeEventListener("pageshow", onPageShow)
      state.browser.removeEventListener("pagehide", onPageHide)
      state.document.removeEventListener("visibilitychange", onVisibility)
      if (analyticsDocument === state) analyticsDocument = undefined
    },
  }
  const onResume = () => { refreshDocumentConsent(state) }
  const onPageShow = (event: PageTransitionEvent) => {
    state.openChannel()
    refreshDocumentConsent(state, { restored: event.persisted })
  }
  const onPageHide = (event: PageTransitionEvent) => {
    state.channel?.close()
    state.channel = undefined
    if (!event.persisted) state.dispose()
  }
  const onVisibility = () => {
    if (state.document.visibilityState === "visible") onResume()
  }
  const onCookieChange = (event: CookieChangeEvent) => {
    if ([...event.changed, ...event.deleted].some(cookie => cookie.name === ANALYTICS_CONSENT_COOKIE)) onResume()
  }
  let cookieStore: CookieStore | undefined
  analyticsDocument = state
  state.browser.addEventListener("focus", onResume)
  state.browser.addEventListener("pageshow", onPageShow)
  state.browser.addEventListener("pagehide", onPageHide)
  state.document.addEventListener("visibilitychange", onVisibility)
  try {
    cookieStore = window.cookieStore
    cookieStore?.addEventListener("change", onCookieChange)
  } catch {}
  state.openChannel()
  return state
}

export function observeAnalyticsConsent(): () => void {
  const state = currentAnalyticsDocument()
  if (!state) return () => {}
  state.observers++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--state.observers === 0) state.dispose()
  }
}

export function refreshAnalyticsConsent({ syncGoogle = false, replace = true } = {}): AnalyticsConsentDecision | null {
  const state = currentAnalyticsDocument()
  return state ? refreshDocumentConsent(state, { syncGoogle, replace }) : readAnalyticsConsent()
}

export function isOptionalAnalyticsStartupLocked(): boolean {
  return analyticsDocument?.startupLocked === true && analyticsDocument.browser === globalThis.window
}

function googleCommand(..._args: unknown[]): void {
  window.dataLayer ??= []
  // eslint-disable-next-line prefer-rest-params -- Google commands use dataLayer.push(arguments).
  window.dataLayer.push(arguments)
}

export function updateGooglePageFields(href: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  try {
    const location = new URL(href, window.location.origin)
    if (location.origin !== window.location.origin || !/^https?:$/.test(location.protocol)) return
    const publicPath = isPublicAnalyticsPath(location.pathname)
    const native = isTauri()
    if (native && !publicPath) return
    const accountPath = /^\/(?:sign-in|auth)(?:\/|$)/.test(location.pathname)
    const publicCategory = /^\/(?:templates|blog)(?:\/|$)/.test(location.pathname)
      ? `/${location.pathname.split("/")[1]}` : location.pathname
    let safeReferrer = ""
    try {
      const referrer = new URL(document.referrer || window.location.origin)
      if (native && publicPath && /^https?:$/.test(referrer.protocol)
        && (referrer.origin !== window.location.origin || isPublicAnalyticsPath(referrer.pathname))) {
        safeReferrer = `${referrer.origin}${referrer.pathname}`
      }
    } catch {}
    googleCommand("set", {
      page_location: `${location.origin}${publicPath ? native ? location.pathname : publicCategory : accountPath ? "/sign-in" : "/c"}`,
      page_referrer: safeReferrer,
      ...(native ? {} : { page_title: publicPath ? "Alook public website" : accountPath ? "Alook account" : "Alook application" }),
    })
  } catch {}
}

export function bootstrapGoogleAnalytics(): () => void {
  if (typeof window === "undefined" || isTauri()) return () => {}
  const stopObserving = observeAnalyticsConsent()
  applyGoogleConsent(readAnalyticsConsent() ?? "denied", "default")
  updateGooglePageFields(window.location.href)
  return stopObserving
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
  const state = currentAnalyticsDocument()
  if (state) state.pendingSaves++
  let confirmed = false
  try {
    const response = await fetch("/api/privacy/analytics-consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    })
    const body = await response.json().catch(() => null) as { decision?: unknown } | null
    if (!response.ok || body?.decision !== decision || !isTauri() && readAnalyticsConsent() !== decision) {
      throw new Error("analytics consent was not saved")
    }
    confirmed = true
    if (state) {
      refreshDocumentConsent(state, { replace: false })
      try { state.channel?.postMessage({ kind: CONSENT_INVALIDATION }) } catch {}
    } else announceAnalyticsConsent(decision)
  } finally {
    if (state) {
      state.pendingSaves--
      refreshDocumentConsent(state, { replace: confirmed })
    }
  }
}

export function announceAnalyticsConsent(decision: AnalyticsConsentDecision): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<AnalyticsConsentDecision>(
    ANALYTICS_CONSENT_CHANGE_EVENT,
    { detail: decision },
  ))
}
