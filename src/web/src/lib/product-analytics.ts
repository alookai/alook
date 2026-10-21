"use client"

import { isTauri } from "@alook/shared"
import { googleCommand, isPublicAnalyticsPath, readAnalyticsConsent } from "@/lib/analytics-consent"
import { LANDING_CTA_NAMES, ONBOARDING_ANALYTICS_STAGES, PRODUCT_ANALYTICS_EVENTS } from "@/lib/product-analytics-contract"
import { authFailureParams } from "@/lib/auth-failure"

export type ProductAnalyticsInput =
  | { event: "landing_cta_clicked"; ctaName: string }
  | { event: "login_page_view" }
  | { event: "sign_up" | "sign_in_success"; method: string }
  | { event: "sign_in_failed"; method: string; failureStage: "send_code" | "verify_code" | "social_start" | "provider_callback"; error: unknown }
  | { event: "onboarding_enter_clicked"; serverId: string }
  | { event: "onboarding_first_message" | "community_onboarding_started" }
  | { event: "community_onboarding_stage_completed" | "community_onboarding_skipped"; stage: string }
  | { event: "invitation_link_visit"; token: string }
  | { event: "community_onboarding_completed" | "human_invitation_sent" | "human_invitation_copied" | "invited_human_joined" }

type EventPayload = { event: ProductAnalyticsInput["event"]; params: Record<string, string> }
type EventFrameWindow = Window & { sendProductEvent?: (input: EventPayload) => void }
const onboardingKey = "alook:onboarding-event"

function prepareProductAnalytics(): HTMLIFrameElement | null {
  if (typeof window === "undefined" || isTauri() || readAnalyticsConsent() === "denied") return null
  try {
    let frame = document.getElementById("alook-product-events") as HTMLIFrameElement | null
    if (!frame) {
      frame = document.createElement("iframe")
      frame.id = "alook-product-events"
      frame.hidden = true
      frame.title = "Alook event analytics"
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin")
      frame.referrerPolicy = "no-referrer"
      frame.src = "/analytics-events.html"
      const created = frame
      frame.addEventListener("load", () => { created.dataset.ready = "true" }, { once: true })
      document.body.appendChild(frame)
    }
    return frame
  } catch { return null }
}

export async function captureProductAnalytics(input: ProductAnalyticsInput, assertCurrent?: () => void): Promise<void> {
  try {
    if (typeof window === "undefined" || window.location.origin !== "https://alook.ai" || isTauri() || readAnalyticsConsent() === "denied") return
    assertCurrent?.()
    if (!PRODUCT_ANALYTICS_EVENTS.some(event => event === input.event)) return
    const params: Record<string, string> = {}
    if (input.event === "community_onboarding_stage_completed" || input.event === "community_onboarding_skipped") {
      if (!ONBOARDING_ANALYTICS_STAGES.some(stage => stage === input.stage)) return
      params.stage = input.stage
    }
    if (input.event === "landing_cta_clicked" && LANDING_CTA_NAMES.some(name => name === input.ctaName)) params.cta_name = input.ctaName
    if ((input.event === "sign_up" || input.event === "sign_in_success" || input.event === "sign_in_failed") && ["email", "email_otp", "github", "google", "apple", "development_password"].includes(input.method)) params.method = input.method
    if (input.event === "sign_in_failed" && ["send_code", "verify_code", "social_start", "provider_callback"].includes(input.failureStage)) params.failure_stage = input.failureStage
    if (input.event === "sign_in_failed") Object.assign(params, authFailureParams(input.error))
    if (isPublicAnalyticsPath(window.location.pathname)) {
      googleCommand("event", input.event, { ...params, send_to: "G-STBCL8F4ZY" })
      return
    }
    const frame = prepareProductAnalytics()
    if (!frame) return
    const target = frame
    const send = () => {
      if (readAnalyticsConsent() === "denied") { target.remove(); return }
      try {
        assertCurrent?.()
        if (!target.isConnected || isTauri()) return
        (target.contentWindow as EventFrameWindow | null)?.sendProductEvent?.({ event: input.event, params })
      } catch {}
    }
    if (frame.dataset.ready === "true") send()
    else frame.addEventListener("load", send, { once: true })
  } catch {}
}

export function beginOnboardingAnalytics(userId: string, serverId: string) {
  try { sessionStorage.setItem(onboardingKey, JSON.stringify([userId, serverId])) } catch {}
  void captureProductAnalytics({ event: "onboarding_enter_clicked", serverId })
}

export function captureOnboardingFirstMessage(userId: string, serverId: string) {
  try {
    if (sessionStorage.getItem(onboardingKey) !== JSON.stringify([userId, serverId])) return
    sessionStorage.removeItem(onboardingKey)
    void captureProductAnalytics({ event: "onboarding_first_message" })
  } catch {}
}
