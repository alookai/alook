export const LANDING_CTA_NAMES = [
  "open_app", "get_started", "templates", "public_nav_open_app", "public_nav_get_started",
  "pricing_open_app", "pricing_get_started", "templates_open_app", "templates_get_started", "closing_open_app", "closing_get_started",
  ...["product", "identity", "continuity", "reach", "ownership", "value_context", "value_flows", "value_attention", "use_cases"].flatMap(section => [`${section}_open_app`, `${section}_get_started`]),
] as const

export const ONBOARDING_ANALYTICS_STAGES = ["harness", "machine", "model", "identity", "initializing"] as const

export const PRODUCT_ANALYTICS_EVENTS = [
  "landing_cta_clicked", "login_page_view", "sign_up", "sign_in_success", "sign_in_failed",
  "onboarding_enter_clicked", "onboarding_first_message", "invitation_link_visit",
  "community_onboarding_started", "community_onboarding_stage_completed", "community_onboarding_skipped",
  "community_onboarding_completed", "human_invitation_sent", "human_invitation_copied", "invited_human_joined",
  "runtime_connected", "first_agent_reply_persisted", "pricing_cta_click", "begin_checkout",
] as const

export const ANALYTICS_ORIGIN = "https://alook.ai"
export const analyticsPlanIds = ["free", "studio", "house"] as const
const analyticsPlanNames = { free: "Free", studio: "Studio", house: "House" } as const
export type AnalyticsPlanId = typeof analyticsPlanIds[number]
export type AnalyticsAuthState = "guest" | "signed_in"
export type AnalyticsCurrentPlan = "none" | AnalyticsPlanId | "founder" | "unknown"
export type BillingEntryPoint = "pricing_page" | "billing_sheet"
export type PricingCtaAction = "start_free" | "open_app" | "manage_cancellation" | "choose_plan"
export type PricingCtaFields = { plan_id: AnalyticsPlanId; cta_action: PricingCtaAction; auth_state: AnalyticsAuthState; current_plan: AnalyticsCurrentPlan; entry_point: BillingEntryPoint }
export type CheckoutFields = { plan_id: Exclude<AnalyticsPlanId, "free">; currency: string; value: number; entry_point: BillingEntryPoint }

const pricingCtaIds = {
  pricing_page: { free: "pricing_free", studio: "pricing_studio", house: "pricing_house" },
  billing_sheet: { studio: "billing_studio", house: "billing_house" },
} as const

export function pricingCtaParams(input: PricingCtaFields) {
  try {
    if (!analyticsPlanIds.includes(input.plan_id) || !["pricing_page", "billing_sheet"].includes(input.entry_point)) return null
    const ids: Partial<Record<AnalyticsPlanId, string>> | undefined = pricingCtaIds[input.entry_point]
    const cta_id = ids?.[input.plan_id]
    if (!cta_id || !["start_free", "open_app", "manage_cancellation", "choose_plan"].includes(input.cta_action)
      || !["guest", "signed_in"].includes(input.auth_state)
      || !["none", ...analyticsPlanIds, "founder", "unknown"].includes(input.current_plan)) return null
    return { plan_id: input.plan_id, cta_id, cta_action: input.cta_action, auth_state: input.auth_state, current_plan: input.current_plan, entry_point: input.entry_point }
  } catch { return null }
}

export function checkoutParams(input: CheckoutFields) {
  try {
    if (!["studio", "house"].includes(input.plan_id) || !["pricing_page", "billing_sheet"].includes(input.entry_point)
      || typeof input.currency !== "string" || !Number.isFinite(input.value) || input.value < 0) return null
    const currency = input.currency.toUpperCase()
    if (!Intl.supportedValuesOf("currency").includes(currency)) return null
    return { currency, value: input.value, items: [{ item_id: input.plan_id, item_name: analyticsPlanNames[input.plan_id], price: input.value, quantity: 1 }], entry_point: input.entry_point }
  } catch { return null }
}
