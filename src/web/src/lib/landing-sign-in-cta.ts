import type { MouseEvent } from "react"
import { isTauri } from "@alook/shared"
import { isPublicAnalyticsPath, readAnalyticsConsent } from "./analytics-consent"
import { ANALYTICS_ORIGIN, LANDING_CTA_NAMES } from "./product-analytics-contract"

const key = "alook:landing-sign-in-cta"
const lifetimeMs = 60_000

export function handoffLandingSignInCta(ctaName: string, navigation: string | MouseEvent<HTMLAnchorElement>): boolean {
  if (window.location.origin !== ANALYTICS_ORIGIN || isTauri() || readAnalyticsConsent() === "denied") return false
  let href: string
  if (typeof navigation === "string") {
    href = navigation
  } else {
    const { currentTarget: link } = navigation
    if (navigation.defaultPrevented || navigation.button !== 0 || navigation.metaKey || navigation.ctrlKey
      || navigation.shiftKey || navigation.altKey || link.hasAttribute("download")
      || (link.target && link.target.toLowerCase() !== "_self")) return false
    href = link.href
  }
  try {
    const target = new URL(href, window.location.href)
    if (target.origin !== ANALYTICS_ORIGIN || target.pathname !== "/sign-in") return false
    window.sessionStorage.setItem(key, JSON.stringify([ctaName, window.location.pathname, Date.now() + lifetimeMs]))
    return true
  } catch {
    return false
  }
}

export function takeLandingSignInCta(): { ctaName: string; sourcePath: string } | null {
  if (window.location.origin !== ANALYTICS_ORIGIN || window.location.pathname !== "/sign-in" || isTauri()) return null
  try {
    const pending = window.sessionStorage.getItem(key)
    if (pending === null) return null
    window.sessionStorage.removeItem(key)
    if (readAnalyticsConsent() === "denied") return null
    const data: unknown = JSON.parse(pending)
    if (!Array.isArray(data)) return null
    const [ctaName, sourcePath, expiresAt] = data
    if (typeof ctaName !== "string" || !LANDING_CTA_NAMES.includes(ctaName)
      || typeof sourcePath !== "string" || !isPublicAnalyticsPath(sourcePath)
      || typeof expiresAt !== "number" || expiresAt <= Date.now()) return null
    return { ctaName, sourcePath }
  } catch {
    return null
  }
}
