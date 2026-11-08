"use client";

import { sendGTMEvent } from "@next/third-parties/google";
import { isTauri } from "@alook/shared"
import { hasAnalyticsConsent, isPublicAnalyticsPath } from "@/lib/analytics-consent"

import { captureProductAnalytics } from "@/lib/product-analytics"
import { LANDING_CTA_NAMES, type ONBOARDING_ANALYTICS_STAGES } from "@/lib/product-analytics-contract"

const analyticsPlanIds = ["free", "studio", "house"] as const

export type AnalyticsAuthState = "guest" | "signed_in"
export type AnalyticsPlanId = typeof analyticsPlanIds[number]
export type AnalyticsCurrentPlan = "none" | "free" | "studio" | "house" | "founder" | "unknown"
export type BillingEntryPoint = "pricing_page" | "billing_sheet"
export type PricingCtaAction = "start_free" | "open_app" | "manage_cancellation" | "choose_plan"
type PricingCtaId = "pricing_free" | "pricing_studio" | "pricing_house" | "billing_studio" | "billing_house"

const analyticsPlanNames: Record<AnalyticsPlanId, string> = {
  free: "Free",
  studio: "Studio",
  house: "House",
}

const pricingCtaIdByEntryPoint: Record<BillingEntryPoint, Partial<Record<AnalyticsPlanId, PricingCtaId>>> = {
  pricing_page: {
    free: "pricing_free",
    studio: "pricing_studio",
    house: "pricing_house",
  },
  billing_sheet: {
    studio: "billing_studio",
    house: "billing_house",
  },
}

const analyticsPlanIdSet = new Set<string>(analyticsPlanIds)

function sendConsentAwareGTMEvent(payload: Record<string, unknown>) {
  try {
    if (typeof window !== "undefined" && /^\/c(?:\/|$)/u.test(window.location.pathname)) return
    const publicWeb = typeof window !== "undefined" && !isTauri() && isPublicAnalyticsPath(window.location.pathname)
    if (!publicWeb && !hasAnalyticsConsent()) return
    sendGTMEvent(payload)
  } catch {
    return
  }
}

export function toAnalyticsPlanId(value: string): AnalyticsPlanId | null {
  return analyticsPlanIdSet.has(value) ? value as AnalyticsPlanId : null
}

export function toAnalyticsCurrentPlan(value: string, isFounder = false): AnalyticsCurrentPlan {
  if (isFounder) return "founder"
  return toAnalyticsPlanId(value) ?? "unknown"
}

export function trackPricingView(params: {
  auth_state: AnalyticsAuthState
  current_plan: AnalyticsCurrentPlan
}) {
  const { auth_state, current_plan } = params
  sendConsentAwareGTMEvent({ event: "pricing_view", auth_state, current_plan })
}

export function trackPricingCtaClick(params: {
  plan_id: AnalyticsPlanId
  cta_action: PricingCtaAction
  auth_state: AnalyticsAuthState
  current_plan: AnalyticsCurrentPlan
  entry_point: BillingEntryPoint
}) {
  const { plan_id, cta_action, auth_state, current_plan, entry_point } = params
  const cta_id = pricingCtaIdByEntryPoint[entry_point][plan_id]
  if (!cta_id) return
  sendConsentAwareGTMEvent({ event: "pricing_cta_click", plan_id, cta_id, cta_action, auth_state, current_plan, entry_point })
}

export function trackBeginCheckout(params: {
  plan_id: Exclude<AnalyticsPlanId, "free">
  currency: string
  value: number
  entry_point: BillingEntryPoint
}) {
  const { plan_id, value, entry_point } = params
  const currency = params.currency.toUpperCase()
  if (!Intl.supportedValuesOf("currency").includes(currency) || !Number.isFinite(value) || value < 0) return
  const item = { item_id: plan_id, item_name: analyticsPlanNames[plan_id], price: value, quantity: 1 as const }
  sendConsentAwareGTMEvent({ event: "begin_checkout", currency, value: item.price * item.quantity, items: [item], entry_point })
}

export type GithubOutboundSurface = "landing" | "blog" | "public_nav" | "public_footer"

export function trackCommunityRuntimeConnected() {
  sendConsentAwareGTMEvent({
    event: "runtime_connected",
    surface: "community",
    connection_type: "local_daemon",
  })
}

export function trackFirstAgentReplyPersisted(
  conversationType: "dm" | "channel" | "thread",
) {
  sendConsentAwareGTMEvent({
    event: "first_agent_reply_persisted",
    surface: "community",
    conversation_type: conversationType,
  })
}

export function trackGithubOutboundClicked(surface: GithubOutboundSurface) {
  sendConsentAwareGTMEvent({
    event: "github_outbound_clicked",
    surface,
    destination: "alook_repo",
  })
}

export type CommunityOnboardingStage = (typeof ONBOARDING_ANALYTICS_STAGES)[number];

export function trackCommunityOnboardingStarted() {
  void captureProductAnalytics({ event: "community_onboarding_started" });
}

export function trackCommunityOnboardingStageCompleted(
  stage: CommunityOnboardingStage,
) {
  void captureProductAnalytics({ event: "community_onboarding_stage_completed", stage });
}

export function trackCommunityOnboardingSkipped(
  stage: CommunityOnboardingStage | "complete",
) {
  void captureProductAnalytics({ event: "community_onboarding_skipped", stage });
}

export function trackLandingCtaClicked(params: { cta_name: string }) {
  if (typeof window === "undefined" || !isPublicAnalyticsPath(window.location.pathname)
    || !LANDING_CTA_NAMES.includes(params.cta_name)) return
  void captureProductAnalytics({ event: "landing_cta_clicked", ctaName: params.cta_name })
}

export function trackTemplatesBrowsed(params: { category_filter: string }) {
  sendConsentAwareGTMEvent({ event: "templates_browsed", ...params });
}
