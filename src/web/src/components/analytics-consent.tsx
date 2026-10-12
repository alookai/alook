"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { GoogleTagManager } from "@next/third-parties/google"
import { isMobile, isTauri } from "@alook/shared"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"
import {
  ANALYTICS_CONSENT_CHANGE_EVENT,
  ANALYTICS_CONSENT_COOKIE,
  announceAnalyticsConsent,
  applyGoogleConsent,
  isPublicAnalyticsPath,
  persistAnalyticsConsent,
  readAnalyticsConsent,
  type AnalyticsConsentDecision,
} from "@/lib/analytics-consent"
import { GeneratedAvatar } from "@/components/avatar"
import styles from "./analytics-consent.module.css"
import { tid } from "@/lib/community/testids"

const GTM_ID = "GTM-56VHCCQZ"
const GA_DISABLE = "ga-disable-G-STBCL8F4ZY"

const reloadingDocuments = new WeakSet<object>()

function reloadAnalyticsDocument() {
  if (reloadingDocuments.has(window)) return
  reloadingDocuments.add(window)
  window.location.reload()
}

function useStoredAnalyticsConsent(syncGoogleConsent = false) {
  const [ready, setReady] = useAtom(useCreateAtom(false))
  const [decision, setDecision] = useAtom(useCreateAtom<AnalyticsConsentDecision | null>(null))
  const [nativeMobile, setNativeMobile] = useAtom(useCreateAtom(false))
  const decisionRef = useRef<AnalyticsConsentDecision | null>(null)

  useEffect(() => {
    const native = isTauri()
    const refresh = (announce = false, initial = false) => {
      const next = readAnalyticsConsent()
      if (syncGoogleConsent && next === "denied") document.getElementById("alook-product-events")?.remove()
      const changed = next !== decisionRef.current
      if (syncGoogleConsent && (changed || initial)) {
        if (!native) applyGoogleConsent(isPublicAnalyticsPath(window.location.pathname) ? next ?? "granted" : "denied")
        else if (initial && next === "granted") applyGoogleConsent(next, "default")
      }
      if (syncGoogleConsent && !native && !initial && next === "denied"
        && decisionRef.current === "granted" && isPublicAnalyticsPath(window.location.pathname)) {
        reloadAnalyticsDocument()
      }
      decisionRef.current = next
      setDecision(next)
      if (syncGoogleConsent && announce && changed) announceAnalyticsConsent(next ?? "denied")
    }
    const onChange = (event: Event) => {
      if (!native) {
        refresh()
        return
      }
      const next = (event as CustomEvent<AnalyticsConsentDecision>).detail
      if (next !== "granted" && next !== "denied") return
      if (syncGoogleConsent) {
        applyGoogleConsent(next, decisionRef.current === null ? "default" : "update")
      }
      decisionRef.current = next
      setDecision(next)
    }
    const onCookieChange = (event: CookieChangeEvent) => {
      if ([...event.changed, ...event.deleted].some(cookie => cookie.name === ANALYTICS_CONSENT_COOKIE)) {
        refresh(true)
      }
    }
    const onResume = () => refresh(true)
    const onVisibility = () => {
      if (document.visibilityState === "visible") onResume()
    }
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onChange)
    let cookieStore: CookieStore | undefined
    if (!native) {
      if (syncGoogleConsent) {
        try {
          cookieStore = window.cookieStore
          cookieStore?.addEventListener("change", onCookieChange)
        } catch {
          cookieStore = undefined
        }
      }
      window.addEventListener("focus", onResume)
      window.addEventListener("pageshow", onResume)
      document.addEventListener("visibilitychange", onVisibility)
    }
    refresh(!native, true)
    setNativeMobile(native && isMobile())
    setReady(true)
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onChange)
      cookieStore?.removeEventListener("change", onCookieChange)
      window.removeEventListener("focus", onResume)
      window.removeEventListener("pageshow", onResume)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [setDecision, setNativeMobile, setReady, syncGoogleConsent])

  return { ready, decision, nativeMobile }
}

function useAnalyticsConsentChoice() {
  const [saving, setSaving] = useAtom(useCreateAtom<AnalyticsConsentDecision | null>(null))
  const [error, setError] = useAtom(useCreateAtom(false))

  const choose = useCallback(async (decision: AnalyticsConsentDecision) => {
    setSaving(decision)
    setError(false)
    try {
      await persistAnalyticsConsent(decision)
      announceAnalyticsConsent(decision)
      if (!isTauri()) reloadAnalyticsDocument()
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }, [setError, setSaving])

  return { choose, saving, error }
}

function ConsentButtons({
  saving,
  onChoose,
}: {
  saving: AnalyticsConsentDecision | null
  onChoose: (decision: AnalyticsConsentDecision) => void
}) {
  const [avatarSeeds, setAvatarSeeds] = useAtom(useCreateAtom([
    "analytics-consent-lantern",
    "analytics-consent-pocket",
    "analytics-consent-orbit",
  ]))

  useEffect(() => {
    setAvatarSeeds(Array.from({ length: 3 }, (_, index) => (
      globalThis.crypto?.randomUUID?.() ?? `analytics-consent-${Date.now()}-${index}`
    )))
  }, [setAvatarSeeds])

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.necessaryButton}
        disabled={saving !== null}
        data-testid={tid.analyticsConsentNecessary}
        onClick={() => onChoose("denied")}
      >
        {saving === "denied" ? "Saving…" : "Only necessary"}
      </button>
      <span className={styles.allowWrap}>
        <span
          className={styles.allowAvatars}
          aria-hidden="true"
          data-testid={tid.analyticsConsentAvatarCluster}
        >
          {avatarSeeds.map((seed) => (
            <span className={styles.allowAvatar} key={seed}>
              <GeneratedAvatar seed={seed} size="100%" className={styles.generatedAvatar} />
            </span>
          ))}
        </span>
        <button
          type="button"
          className={styles.allowButton}
          disabled={saving !== null}
          data-testid={tid.analyticsConsentAllow}
          onClick={() => onChoose("granted")}
        >
          {saving === "granted" ? "Saving…" : "Allow analytics"}
        </button>
      </span>
    </div>
  )
}

export function AnalyticsConsent() {
  const pathname = usePathname()
  const { ready, decision, nativeMobile } = useStoredAnalyticsConsent(true)
  const defaultStarted = useRef(false)
  const [defaultSettled, setDefaultSettled] = useAtom(useCreateAtom(false))

  useEffect(() => {
    if (!ready || nativeMobile || decision !== null || defaultStarted.current) return
    if (!pathname || !isPublicAnalyticsPath(pathname)) return
    defaultStarted.current = true
    void persistAnalyticsConsent("granted").then(() => announceAnalyticsConsent("granted")).catch(() => {}).finally(() => setDefaultSettled(true))
  }, [ready, nativeMobile, decision, pathname, setDefaultSettled])

  const googleAllowed = ready && !!pathname && isPublicAnalyticsPath(pathname) && (!isTauri() || decision === "granted")
  const allowed = googleAllowed && (isTauri() ? decision === "granted" : decision !== "denied")
  useEffect(() => {
    if (!isTauri()) return
    Object.defineProperty(window, GA_DISABLE, {
      configurable: true,
      get: () => readAnalyticsConsent() !== "granted" || !isPublicAnalyticsPath(window.location.pathname),
    })
  }, [])
  useEffect(() => {
    if (!isTauri() || decision !== "granted") return
    const referrer = new URL(document.referrer || window.location.origin)
    const safeReferrer = referrer.origin !== window.location.origin || isPublicAnalyticsPath(referrer.pathname)
      ? `${referrer.origin}${referrer.pathname}` : ""
    window.dataLayer ??= []
    window.dataLayer.push(["set", "page_referrer", safeReferrer])
  }, [decision])

  return (
    <>
      {googleAllowed && (decision !== null || defaultSettled) ? <GoogleTagManager gtmId={GTM_ID} /> : null}
      {allowed ? (
        <iframe
          key={pathname}
          title="Ahrefs analytics"
          data-testid={tid.ahrefsAnalyticsFrame}
          hidden aria-hidden="true"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={`<title>Alook</title><script async src="https://analytics.ahrefs.com/analytics.js" data-key="Td2Wr/poHD0pDEV30W9xMw" data-page-location="${new URL(pathname!, window.location.origin).href.replace(/"/g, "%22")}"></script>`}
        />
      ) : null}
    </>
  )
}
export function AnalyticsPreferenceControl() {
  const { ready, decision } = useStoredAnalyticsConsent()
  const { choose, saving, error } = useAnalyticsConsentChoice()
  const status = decision === "granted"
    ? "Analytics cookies allowed"
    : decision === "denied"
      ? "Analytics cookies denied"
      : "Analytics cookies allowed by default"

  return (
    <section
      id="analytics-choices"
      className={styles.preferenceControl}
      data-testid={tid.analyticsPreferenceControl}
    >
      <div className={styles.copy}>
        <p className={styles.eyebrow}>PRIVACY · BROWSER PREFERENCE</p>
        <h2 className={styles.preferenceHeading}>Analytics choices</h2>
        <p className={styles.description}>
          {ready ? status : "Reading this browser’s choice…"}. Necessary cookies keep sign-in and
          security working either way.
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            Couldn’t save this choice. Try again.
          </p>
        ) : null}
      </div>
      <ConsentButtons saving={saving} onChoose={choose} />
    </section>
  )
}
