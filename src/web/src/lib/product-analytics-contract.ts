export const LANDING_CTA_NAMES = [
  "open_app", "get_started", "templates", "public_nav_open_app", "public_nav_get_started",
  "pricing_open_app", "pricing_get_started", "templates_open_app", "templates_get_started", "closing_open_app", "closing_get_started",
  ...["product", "identity", "continuity", "reach", "ownership"].flatMap(section => [`${section}_open_app`, `${section}_get_started`]),
] as const

export const ONBOARDING_ANALYTICS_STAGES = ["harness", "machine", "model", "identity", "initializing"] as const

export const PRODUCT_ANALYTICS_EVENTS = [
  "landing_cta_clicked", "login_page_view", "sign_up", "sign_in_success", "sign_in_failed",
  "onboarding_enter_clicked", "onboarding_first_message", "invitation_link_visit",
  "community_onboarding_started", "community_onboarding_stage_completed", "community_onboarding_skipped",
  "community_onboarding_completed", "human_invitation_sent", "human_invitation_copied", "invited_human_joined",
] as const
