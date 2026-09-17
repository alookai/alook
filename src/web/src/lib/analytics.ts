"use client";

import { sendGTMEvent } from "@next/third-parties/google";
import { hasAnalyticsConsent } from "@/lib/analytics-consent"

const analyticsAuthStates = ["guest", "signed_in"] as const
const analyticsPlanIds = ["free", "studio", "house"] as const
const analyticsCurrentPlans = ["none", "free", "studio", "house", "founder", "unknown"] as const
const billingEntryPoints = ["pricing_page", "billing_sheet"] as const
const pricingCtaActions = ["start_free", "open_app", "manage_cancellation", "choose_plan"] as const
const pricingCtaIds = ["pricing_free", "pricing_studio", "pricing_house", "billing_studio", "billing_house"] as const

export type AnalyticsAuthState = typeof analyticsAuthStates[number]
export type AnalyticsPlanId = typeof analyticsPlanIds[number]
export type AnalyticsCurrentPlan = typeof analyticsCurrentPlans[number]
export type BillingEntryPoint = typeof billingEntryPoints[number]
export type PricingCtaAction = typeof pricingCtaActions[number]
type PricingCtaId = typeof pricingCtaIds[number]

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
  if (!hasAnalyticsConsent()) return
  try {
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

function sendCommercialEvent(payload: Record<string, unknown>) {
  try {
    sendConsentAwareGTMEvent(payload)
  } catch {
    return
  }
}

function sendFunnelEvent(payload: Record<string, unknown>) {
  try {
    sendConsentAwareGTMEvent(payload)
  } catch {
    return
  }
}

export function trackPricingView(params: {
  auth_state: AnalyticsAuthState
  current_plan: AnalyticsCurrentPlan
}) {
  const { auth_state, current_plan } = params
  sendCommercialEvent({ event: "pricing_view", auth_state, current_plan })
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
  sendCommercialEvent({ event: "pricing_cta_click", plan_id, cta_id, cta_action, auth_state, current_plan, entry_point })
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
  sendCommercialEvent({ event: "begin_checkout", currency, value: item.price * item.quantity, items: [item], entry_point })
}

// ─── P0 — Core Funnel Events ───────────────────────────────────────────────

export function trackSignUp(method: string) {
  sendConsentAwareGTMEvent({ event: "sign_up", method });
}

export function trackSignInSuccess(method: string) {
  sendConsentAwareGTMEvent({ event: "sign_in_success", method });
}

export function trackWorkspaceCreated(source: "onboarding" | "manual") {
  sendConsentAwareGTMEvent({ event: "workspace_created", source });
}

export function trackAgentCreated(params: {
  is_first_agent: boolean;
  has_email: boolean;
  template_id?: string;
}) {
  sendConsentAwareGTMEvent({ event: "agent_created", ...params });
}

export function trackOnboardingCompleted(params: {
  template_used?: string;
  agent_count: number;
}) {
  sendConsentAwareGTMEvent({ event: "onboarding_completed", ...params });
}

export function trackAgentChatOpened(params: {
  agent_id: string;
  is_first_chat: boolean;
}) {
  sendConsentAwareGTMEvent({ event: "agent_chat_opened", ...params });
}

export function trackMessageSent(params: {
  agent_id: string;
  message_length: number;
}) {
  sendConsentAwareGTMEvent({ event: "message_sent", ...params });
}

// ─── P1 — Feature Usage Events ─────────────────────────────────────────────

export function trackEmailComposed(params: {
  agent_id: string;
  has_attachments: boolean;
}) {
  sendConsentAwareGTMEvent({ event: "email_composed", ...params });
}

export function trackEmailReceived(params: {
  agent_id: string;
  mailbox_type: "alook" | "imap";
}) {
  sendConsentAwareGTMEvent({ event: "email_received", ...params });
}

export function trackCalendarEventCreated(params: {
  agent_id: string;
  is_recurring: boolean;
}) {
  sendConsentAwareGTMEvent({ event: "calendar_event_created", ...params });
}

export function trackIssueCreated(params: { agent_id: string }) {
  sendConsentAwareGTMEvent({ event: "issue_created", ...params });
}

export function trackIssueStatusChanged(params: {
  from: string;
  to: string;
  method: "drag" | "button";
}) {
  sendConsentAwareGTMEvent({ event: "issue_status_changed", ...params });
}

export function trackThreadViewed(params: {
  agent_count: number;
  status: string;
}) {
  sendConsentAwareGTMEvent({ event: "thread_viewed", ...params });
}

export function trackTemplateUsed(params: {
  template_id: string;
  template_name: string;
}) {
  sendConsentAwareGTMEvent({ event: "template_used", ...params });
}

export function trackCustomEmailConnected(params: { email_domain: string }) {
  sendConsentAwareGTMEvent({ event: "custom_email_connected", ...params });
}

// ─── P2 — Growth & Retention Signals ───────────────────────────────────────

export function trackTeamMemberInvited(params: { workspace_id: string }) {
  sendConsentAwareGTMEvent({ event: "team_member_invited", ...params });
}

export function trackInviteAccepted(params: { workspace_id: string }) {
  sendConsentAwareGTMEvent({ event: "invite_accepted", ...params });
}

export function trackSecondAgentCreated(params: { total_agents: number }) {
  sendConsentAwareGTMEvent({ event: "second_agent_created", ...params });
}

export function trackAgentLinkCreated(params: {
  source_agent: string;
  target_agent: string;
}) {
  sendConsentAwareGTMEvent({ event: "agent_link_created", ...params });
}

export function trackRuntimeConnected(params: {
  runtime_type: "desktop" | "cloud";
}) {
  sendConsentAwareGTMEvent({ event: "runtime_connected", ...params });
}

export type GithubOutboundSurface = "landing" | "blog" | "public_nav" | "public_footer"

export function trackCommunityRuntimeConnected() {
  sendFunnelEvent({
    event: "runtime_connected",
    surface: "community",
    connection_type: "local_daemon",
  })
}

export function trackFirstAgentReplyPersisted(
  conversationType: "dm" | "channel" | "thread",
) {
  sendFunnelEvent({
    event: "first_agent_reply_persisted",
    surface: "community",
    conversation_type: conversationType,
  })
}

export function trackHumanInvitationSent() {
  sendFunnelEvent({
    event: "human_invitation_sent",
    surface: "community",
    invite_method: "dm",
  })
}

export function trackHumanInvitationCopied() {
  sendFunnelEvent({
    event: "human_invitation_copied",
    surface: "community",
    invite_method: "link_copy",
  })
}

export function trackInvitedHumanJoined() {
  sendFunnelEvent({ event: "invited_human_joined", surface: "community" })
}

export function trackGithubOutboundClicked(surface: GithubOutboundSurface) {
  sendFunnelEvent({
    event: "github_outbound_clicked",
    surface,
    destination: "alook_repo",
  })
}

export type CommunityOnboardingStage =
  | "harness"
  | "machine"
  | "identity"
  | "initializing"
  | "bot"
  | "dm"
  | "server";

export function trackCommunityOnboardingStarted() {
  sendConsentAwareGTMEvent({ event: "community_onboarding_started" });
}

export function trackCommunityOnboardingStageCompleted(
  stage: CommunityOnboardingStage,
) {
  sendConsentAwareGTMEvent({ event: "community_onboarding_stage_completed", stage });
}

export function trackCommunityOnboardingCompleted() {
  sendConsentAwareGTMEvent({ event: "community_onboarding_completed" });
}

export function trackCommunityOnboardingSkipped(
  stage: CommunityOnboardingStage | "complete",
) {
  sendConsentAwareGTMEvent({ event: "community_onboarding_skipped", stage });
}

export type CommunityWsFrameDropReason =
  | "oversized"
  | "invalid-json"
  | "non-object"
  | "missing-type"
  | "wrong-family"
  | "unknown-community-type"
  | "invalid-payload"
  | "invalid-target"
  | "too-many-targets"
  | "pre-auth-frame"
  | "duplicate-auth-ok"

export type CommunityWsReconcilePolicy =
  | "focused-messages"
  | "focused-opener"
  | "focused-channel-roster"
  | "focused-pins"
  | "focused-threads"
  | "inbox-dms"
  | "cached-read-state"
  | "all-cached-servers"
  | "friends"
  | "presence-overlay"
  | "status-overlay"
  | "identity-surfaces"
  | "ephemeral-typing"
  | "machines"
  | "bot-audits"

export type CommunityWsLifecycleRecoveryTrigger =
  | "focus"
  | "online"
  | "pageshow"
  | "resume"
  | "sentinel"
  | "visibility"

export type CommunityWsLifecycleRecoveryStrategy = "replace" | "validate"

export type CommunityWsSocketReadyState =
  | "closed"
  | "closing"
  | "connecting"
  | "none"
  | "open"

export type CommunityWsSuspensionDurationBucket =
  | "30s-2m"
  | "over-2m"
  | "under-30s"
  | "unknown"

export type CommunityWsCloseInitiator =
  | "auth-failure"
  | "connect-timeout"
  | "freeze"
  | "heartbeat-timeout"
  | "local-retire"
  | "manual-retry"
  | "offline"
  | "remote"
  | "validation-failure"
  | "validation-timeout"

export type CommunityWsCloseReasonBucket =
  | "abnormal"
  | "going-away"
  | "normal"
  | "other"
  | "policy"
  | "server-error"
  | "unknown"

export type CommunityWsAuthFailureClass =
  | "credentials"
  | "network"
  | "server"
  | "timeout"
  | "unknown"

export type CommunityWsLifecycleStage = "auth" | "open" | "token" | "validation"

export type CommunityWsLifecycleStageResult =
  | "aborted"
  | "failure"
  | "success"
  | "timeout"

function boundedCommunityWsInteger(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.round(value)), maximum)
}

function sendCommunityWsGTMEvent(payload: Record<string, unknown>) {
  try {
    sendConsentAwareGTMEvent(payload)
  } catch {
    return
  }
}

export function trackCommunityWsFrameDropped(params: {
  reason: CommunityWsFrameDropReason
  type: string
  byteCount?: number
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_frame_dropped",
    reason: params.reason,
    type: params.type,
    ...(params.byteCount === undefined ? {} : { byteCount: params.byteCount }),
  });
}

export function trackCommunityWsReconcileComplete(params: {
  policyCount: number
  successCount: number
  failureCount: number
  durationMs: number
  reconnectDurationMs: number
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_reconcile_complete",
    policyCount: params.policyCount,
    successCount: params.successCount,
    failureCount: params.failureCount,
    durationMs: params.durationMs,
    reconnectDurationMs: params.reconnectDurationMs,
  });
}

export function trackCommunityWsReconcileFailure(params: {
  policy: CommunityWsReconcilePolicy
  reason: "sync-throw" | "async-rejection" | "unknown"
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_reconcile_failure",
    policy: params.policy,
    reason: params.reason,
  });
}

export function trackCommunityWsLifecycleRecovery(params: {
  trigger: CommunityWsLifecycleRecoveryTrigger
  strategy: CommunityWsLifecycleRecoveryStrategy
  socketReadyState: CommunityWsSocketReadyState
  suspensionDuration: CommunityWsSuspensionDurationBucket
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_lifecycle_recovery",
    trigger: params.trigger,
    strategy: params.strategy,
    socketReadyState: params.socketReadyState,
    suspensionDuration: params.suspensionDuration,
  });
}

export function trackCommunityWsLifecycleClose(params: {
  initiator: CommunityWsCloseInitiator
  code: number
  wasClean: boolean
  reasonBucket: CommunityWsCloseReasonBucket
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_lifecycle_close",
    initiator: params.initiator,
    code: boundedCommunityWsInteger(params.code, 4999),
    wasClean: params.wasClean === true,
    reasonBucket: params.reasonBucket,
  });
}

export function trackCommunityWsAuthFailure(params: {
  failureClass: CommunityWsAuthFailureClass
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_auth_failure",
    failureClass: params.failureClass,
  });
}

export function trackCommunityWsLifecycleStage(params: {
  stage: CommunityWsLifecycleStage
  result: CommunityWsLifecycleStageResult
  durationMs: number
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_lifecycle_stage",
    stage: params.stage,
    result: params.result,
    durationMs: boundedCommunityWsInteger(params.durationMs, 600_000),
  });
}

export function trackCommunityWsRetryScheduled(params: {
  attempt: number
  delayMs: number
  windowMs: number
}) {
  sendCommunityWsGTMEvent({
    event: "community_ws_retry_scheduled",
    attempt: boundedCommunityWsInteger(params.attempt, 1_000),
    delayMs: boundedCommunityWsInteger(params.delayMs, 600_000),
    windowMs: boundedCommunityWsInteger(params.windowMs, 600_000),
  });
}

// ─── P3 — Page-Level Behavior ───────────────────────────────────────────────

export function trackLandingCtaClicked(params: { cta_name: string }) {
  sendConsentAwareGTMEvent({ event: "landing_cta_clicked", ...params });
}

export function trackTemplatesBrowsed(params: { category_filter: string }) {
  sendConsentAwareGTMEvent({ event: "templates_browsed", ...params });
}

export function trackSettingsUpdated(params: { setting_tab: string }) {
  sendConsentAwareGTMEvent({ event: "settings_updated", ...params });
}

export function trackCanvasLayoutChanged(params: { layout_type: string }) {
  sendConsentAwareGTMEvent({ event: "canvas_layout_changed", ...params });
}
