"use client";

import type { MouseEvent } from "react"
import { sendGTMEvent } from "@next/third-parties/google";
import { isTauri } from "@alook/shared"
import { hasAnalyticsConsent, isPublicAnalyticsPath, readAnalyticsConsent } from "@/lib/analytics-consent"

import { captureProductAnalytics } from "@/lib/product-analytics"
import { handoffLandingSignInCta } from "@/lib/landing-sign-in-cta"
import { LANDING_CTA_NAMES, BLOG_NEWSLETTER_PLACEMENTS, ANALYTICS_ORIGIN, analyticsPlanIds, pricingCtaParams, checkoutParams, type BlogNewsletterPlacement, type ONBOARDING_ANALYTICS_STAGES, type PricingCtaFields, type CheckoutFields } from "@/lib/product-analytics-contract"
import { TEMPLATE_CATEGORIES } from "@/lib/templates/types"
export type { AnalyticsAuthState, AnalyticsPlanId, AnalyticsCurrentPlan, BillingEntryPoint, PricingCtaAction } from "@/lib/product-analytics-contract"
import type { AnalyticsPlanId, AnalyticsAuthState, AnalyticsCurrentPlan } from "@/lib/product-analytics-contract"

const analyticsPlanIdSet = new Set<string>(analyticsPlanIds)

function sendConsentAwareGTMEvent(payload: Record<string, unknown>, assertCurrent?: () => void) {
  try {
    if (typeof window === "undefined" || !isPublicAnalyticsPath(window.location.pathname)
      || readAnalyticsConsent() === "denied") return
    if (isTauri() ? !hasAnalyticsConsent() : window.location.origin !== ANALYTICS_ORIGIN) return
    assertCurrent?.()
    sendGTMEvent(payload)
  } catch {}
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
  if (!["guest", "signed_in"].includes(auth_state) || !["none", ...analyticsPlanIds, "founder", "unknown"].includes(current_plan)) return
  sendConsentAwareGTMEvent({ event: "pricing_view", auth_state, current_plan })
}

export function trackPricingCtaClick(params: PricingCtaFields, assertCurrent?: () => void) {
  const safe = pricingCtaParams(params)
  if (!safe) return
  if (typeof window !== "undefined" && /^\/c(?:\/|$)/u.test(window.location.pathname)) {
    return captureProductAnalytics({ event: "pricing_cta_click", ...params }, assertCurrent)
  }
  sendConsentAwareGTMEvent({ event: "pricing_cta_click", ...safe }, assertCurrent)
}

export function trackBeginCheckout(params: CheckoutFields, assertCurrent?: () => void) {
  const safe = checkoutParams(params)
  if (!safe) return
  if (typeof window !== "undefined" && /^\/c(?:\/|$)/u.test(window.location.pathname)) {
    return captureProductAnalytics({ event: "begin_checkout", ...params }, assertCurrent)
  }
  sendConsentAwareGTMEvent({ event: "begin_checkout", ...safe }, assertCurrent)
}

export type GithubOutboundSurface = "landing" | "blog" | "public_nav" | "public_footer"

export function trackCommunityRuntimeConnected(assertCurrent?: () => void) {
  return captureProductAnalytics({ event: "runtime_connected" }, assertCurrent)
}

export function trackFirstAgentReplyPersisted(
  conversationType: "dm" | "channel" | "thread",
  assertCurrent?: () => void,
) {
  return captureProductAnalytics({ event: "first_agent_reply_persisted", conversationType }, assertCurrent)
}

export function trackGithubOutboundClicked(surface: GithubOutboundSurface) {
  if (!["landing", "blog", "public_nav", "public_footer"].includes(surface)) return
  sendConsentAwareGTMEvent({
    event: "github_outbound_clicked",
    surface,
    destination: "alook_repo",
  })
}

export type CommunityOnboardingStage = (typeof ONBOARDING_ANALYTICS_STAGES)[number];

export function trackCommunityOnboardingStarted(assertCurrent?: () => void) {
  void captureProductAnalytics({ event: "community_onboarding_started" }, assertCurrent);
}

export function trackCommunityOnboardingStageCompleted(
  stage: CommunityOnboardingStage,
  assertCurrent?: () => void,
) {
  void captureProductAnalytics({ event: "community_onboarding_stage_completed", stage }, assertCurrent);
}

export function trackCommunityOnboardingSkipped(
  stage: CommunityOnboardingStage | "complete",
  assertCurrent?: () => void,
) {
  void captureProductAnalytics({ event: "community_onboarding_skipped", stage }, assertCurrent);
}

export function trackLandingCtaClicked(params: { cta_name: string }, navigation?: string | MouseEvent<HTMLAnchorElement>) {
  if (typeof window === "undefined" || !isPublicAnalyticsPath(window.location.pathname)
    || !LANDING_CTA_NAMES.includes(params.cta_name)) return
  if (navigation && handoffLandingSignInCta(params.cta_name, navigation)) return
  void captureProductAnalytics({ event: "landing_cta_clicked", ctaName: params.cta_name })
}

export function trackTemplatesBrowsed(params: { category_filter: string }) {
  if (!["All", ...TEMPLATE_CATEGORIES].includes(params.category_filter)) return
  sendConsentAwareGTMEvent({ event: "templates_browsed", category_filter: params.category_filter });
}

export function trackBlogNewsletterSubscribed(params: { placement: BlogNewsletterPlacement; sourcePath?: string }) {
  if (typeof window === "undefined" || !isPublicAnalyticsPath(window.location.pathname)
    || !BLOG_NEWSLETTER_PLACEMENTS.includes(params.placement)) return
  void captureProductAnalytics({
    event: "blog_newsletter_subscribed",
    placement: params.placement,
    sourcePath: params.sourcePath ?? window.location.pathname,
  })
}
