"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { GoogleTagManager } from "@next/third-parties/google"
import { isMobile, isTauri } from "@alook/shared"
import { useCallback, useEffect, useRef } from "react"
import { GeneratedAvatar } from "@/components/avatar"
import {
  ANALYTICS_CONSENT_CHANGE_EVENT,
  announceAnalyticsConsent,
  applyGoogleConsent,
  persistAnalyticsConsent,
  readAnalyticsConsent,
  type AnalyticsConsentDecision,
} from "@/lib/analytics-consent"
import { tid } from "@/lib/community/testids"
import styles from "./analytics-consent.module.css"

const GTM_ID = "GTM-56VHCCQZ"

function useStoredAnalyticsConsent(syncGoogleConsent = false) {
  const [ready, setReady] = useAtom(useCreateAtom(false))
  const [decision, setDecision] = useAtom(useCreateAtom<AnalyticsConsentDecision | null>(null))
  const [nativeMobile, setNativeMobile] = useAtom(useCreateAtom(false))
  const decisionRef = useRef<AnalyticsConsentDecision | null>(null)

  useEffect(() => {
    const stored = readAnalyticsConsent()
    if (syncGoogleConsent && stored === "granted") applyGoogleConsent(stored, "default")
    decisionRef.current = stored
    setDecision(stored)
    setNativeMobile(isTauri() && isMobile())
    setReady(true)

    const onChange = (event: Event) => {
      const next = (event as CustomEvent<AnalyticsConsentDecision>).detail
      if (next !== "granted" && next !== "denied") return
      if (syncGoogleConsent) {
        applyGoogleConsent(next, decisionRef.current === null ? "default" : "update")
      }
      decisionRef.current = next
      setDecision(next)
    }
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onChange)
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
  const { ready, decision, nativeMobile } = useStoredAnalyticsConsent(true)
  const { choose, saving, error } = useAnalyticsConsentChoice()

  return (
    <>
      {ready && decision === "granted" ? <GoogleTagManager gtmId={GTM_ID} /> : null}
      {ready && !nativeMobile && decision === null ? (
        <section
          aria-label="Analytics choices"
          className={styles.banner}
          data-testid={tid.analyticsConsentBanner}
        >
          <div className={styles.bannerContent}>
            <div className={styles.copy}>
              <p className={styles.eyebrow}>PRIVACY · OPTIONAL SIGNAL</p>
              <h2 className={styles.headline}>Analytics, only if you want</h2>
              <p className={styles.description}>
                Optional analytics help us understand which parts of Alook are useful. No ad
                tracking. Read our{" "}
                <a
                  href="/privacy#analytics-choices"
                  className={styles.privacyLink}
                >
                  privacy details
                </a>{"."}
              </p>
              {error ? (
                <p className={styles.error} role="alert">
                  Couldn’t save this choice. Try again.
                </p>
              ) : null}
            </div>
            <ConsentButtons saving={saving} onChoose={choose} />
          </div>
        </section>
      ) : null}
    </>
  )
}

export function AnalyticsPreferenceControl() {
  const { ready, decision } = useStoredAnalyticsConsent()
  const { choose, saving, error } = useAnalyticsConsentChoice()
  const status = decision === "granted"
    ? "Optional analytics allowed"
    : decision === "denied"
      ? "Only necessary cookies"
      : "No choice saved"

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
