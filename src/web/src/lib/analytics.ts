"use client";

import { sendGTMEvent } from "@next/third-parties/google";

// ─── P0 — Core Funnel Events ───────────────────────────────────────────────

export function trackSignUp(method: string) {
  sendGTMEvent({ event: "sign_up", method });
}

export function trackSignInSuccess(method: string) {
  sendGTMEvent({ event: "sign_in_success", method });
}

export function trackWorkspaceCreated(source: "onboarding" | "manual") {
  sendGTMEvent({ event: "workspace_created", source });
}

export function trackAgentCreated(params: {
  is_first_agent: boolean;
  has_email: boolean;
  template_id?: string;
}) {
  sendGTMEvent({ event: "agent_created", ...params });
}

export function trackOnboardingCompleted(params: {
  template_used?: string;
  agent_count: number;
}) {
  sendGTMEvent({ event: "onboarding_completed", ...params });
}

export function trackAgentChatOpened(params: {
  agent_id: string;
  is_first_chat: boolean;
}) {
  sendGTMEvent({ event: "agent_chat_opened", ...params });
}

export function trackMessageSent(params: {
  agent_id: string;
  message_length: number;
}) {
  sendGTMEvent({ event: "message_sent", ...params });
}

// ─── P1 — Feature Usage Events ─────────────────────────────────────────────

export function trackEmailComposed(params: {
  agent_id: string;
  has_attachments: boolean;
}) {
  sendGTMEvent({ event: "email_composed", ...params });
}

export function trackEmailReceived(params: {
  agent_id: string;
  mailbox_type: "alook" | "imap";
}) {
  sendGTMEvent({ event: "email_received", ...params });
}

export function trackCalendarEventCreated(params: {
  agent_id: string;
  is_recurring: boolean;
}) {
  sendGTMEvent({ event: "calendar_event_created", ...params });
}

export function trackIssueCreated(params: { agent_id: string }) {
  sendGTMEvent({ event: "issue_created", ...params });
}

export function trackIssueStatusChanged(params: {
  from: string;
  to: string;
  method: "drag" | "button";
}) {
  sendGTMEvent({ event: "issue_status_changed", ...params });
}

export function trackThreadViewed(params: {
  agent_count: number;
  status: string;
}) {
  sendGTMEvent({ event: "thread_viewed", ...params });
}

export function trackTemplateUsed(params: {
  template_id: string;
  template_name: string;
}) {
  sendGTMEvent({ event: "template_used", ...params });
}

export function trackCustomEmailConnected(params: { email_domain: string }) {
  sendGTMEvent({ event: "custom_email_connected", ...params });
}

// ─── P2 — Growth & Retention Signals ───────────────────────────────────────

export function trackTeamMemberInvited(params: { workspace_id: string }) {
  sendGTMEvent({ event: "team_member_invited", ...params });
}

export function trackInviteAccepted(params: { workspace_id: string }) {
  sendGTMEvent({ event: "invite_accepted", ...params });
}

export function trackSecondAgentCreated(params: { total_agents: number }) {
  sendGTMEvent({ event: "second_agent_created", ...params });
}

export function trackAgentLinkCreated(params: {
  source_agent: string;
  target_agent: string;
}) {
  sendGTMEvent({ event: "agent_link_created", ...params });
}

export function trackRuntimeConnected(params: {
  runtime_type: "desktop" | "cloud";
}) {
  sendGTMEvent({ event: "runtime_connected", ...params });
}

// ─── P3 — Page-Level Behavior ───────────────────────────────────────────────

export function trackLandingCtaClicked(params: { cta_name: string }) {
  sendGTMEvent({ event: "landing_cta_clicked", ...params });
}

export function trackTemplatesBrowsed(params: { category_filter: string }) {
  sendGTMEvent({ event: "templates_browsed", ...params });
}

export function trackSettingsUpdated(params: { setting_tab: string }) {
  sendGTMEvent({ event: "settings_updated", ...params });
}

export function trackCanvasLayoutChanged(params: { layout_type: string }) {
  sendGTMEvent({ event: "canvas_layout_changed", ...params });
}
