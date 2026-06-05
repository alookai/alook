import { describe, it, expect, vi, beforeEach } from "vitest"

const mockSendGTMEvent = vi.fn()
vi.mock("@next/third-parties/google", () => ({
  sendGTMEvent: (...args: unknown[]) => mockSendGTMEvent(...args),
}))

import {
  trackSignUp,
  trackSignInSuccess,
  trackWorkspaceCreated,
  trackAgentCreated,
  trackOnboardingCompleted,
  trackAgentChatOpened,
  trackMessageSent,
  trackEmailComposed,
  trackEmailReceived,
  trackCalendarEventCreated,
  trackIssueCreated,
  trackIssueStatusChanged,
  trackThreadViewed,
  trackTemplateUsed,
  trackCustomEmailConnected,
  trackTeamMemberInvited,
  trackInviteAccepted,
  trackSecondAgentCreated,
  trackAgentLinkCreated,
  trackRuntimeConnected,
  trackLandingCtaClicked,
  trackTemplatesBrowsed,
  trackSettingsUpdated,
  trackCanvasLayoutChanged,
} from "./analytics"

describe("analytics utility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("P0 — Core Funnel Events", () => {
    it("trackSignUp sends sign_up event", () => {
      trackSignUp("github")
      expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "github" })
    })

    it("trackSignInSuccess sends sign_in_success event", () => {
      trackSignInSuccess("email_otp")
      expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_in_success", method: "email_otp" })
    })

    it("trackWorkspaceCreated sends workspace_created event", () => {
      trackWorkspaceCreated("onboarding")
      expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "workspace_created", source: "onboarding" })
    })

    it("trackAgentCreated sends agent_created event with all params", () => {
      trackAgentCreated({ is_first_agent: true, has_email: false, template_id: "tmpl_1" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "agent_created",
        is_first_agent: true,
        has_email: false,
        template_id: "tmpl_1",
      })
    })

    it("trackOnboardingCompleted sends onboarding_completed event", () => {
      trackOnboardingCompleted({ template_used: "startup", agent_count: 3 })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "onboarding_completed",
        template_used: "startup",
        agent_count: 3,
      })
    })

    it("trackAgentChatOpened sends agent_chat_opened event", () => {
      trackAgentChatOpened({ agent_id: "ag_123", is_first_chat: true })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "agent_chat_opened",
        agent_id: "ag_123",
        is_first_chat: true,
      })
    })

    it("trackMessageSent sends message_sent event", () => {
      trackMessageSent({ agent_id: "ag_123", message_length: 42 })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "message_sent",
        agent_id: "ag_123",
        message_length: 42,
      })
    })
  })

  describe("P1 — Feature Usage Events", () => {
    it("trackEmailComposed sends email_composed event", () => {
      trackEmailComposed({ agent_id: "ag_1", has_attachments: true })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "email_composed",
        agent_id: "ag_1",
        has_attachments: true,
      })
    })

    it("trackEmailReceived sends email_received event", () => {
      trackEmailReceived({ agent_id: "ag_1", mailbox_type: "imap" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "email_received",
        agent_id: "ag_1",
        mailbox_type: "imap",
      })
    })

    it("trackCalendarEventCreated sends calendar_event_created event", () => {
      trackCalendarEventCreated({ agent_id: "ag_1", is_recurring: false })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "calendar_event_created",
        agent_id: "ag_1",
        is_recurring: false,
      })
    })

    it("trackIssueCreated sends issue_created event", () => {
      trackIssueCreated({ agent_id: "ag_1" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "issue_created",
        agent_id: "ag_1",
      })
    })

    it("trackIssueStatusChanged sends issue_status_changed event", () => {
      trackIssueStatusChanged({ from: "todo", to: "running", method: "drag" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "issue_status_changed",
        from: "todo",
        to: "running",
        method: "drag",
      })
    })

    it("trackThreadViewed sends thread_viewed event", () => {
      trackThreadViewed({ agent_count: 3, status: "completed" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "thread_viewed",
        agent_count: 3,
        status: "completed",
      })
    })

    it("trackTemplateUsed sends template_used event", () => {
      trackTemplateUsed({ template_id: "t_1", template_name: "Startup" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "template_used",
        template_id: "t_1",
        template_name: "Startup",
      })
    })

    it("trackCustomEmailConnected sends custom_email_connected event", () => {
      trackCustomEmailConnected({ email_domain: "gmail.com" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "custom_email_connected",
        email_domain: "gmail.com",
      })
    })
  })

  describe("P2 — Growth & Retention Signals", () => {
    it("trackTeamMemberInvited sends team_member_invited event", () => {
      trackTeamMemberInvited({ workspace_id: "ws_1" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "team_member_invited",
        workspace_id: "ws_1",
      })
    })

    it("trackInviteAccepted sends invite_accepted event", () => {
      trackInviteAccepted({ workspace_id: "ws_1" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "invite_accepted",
        workspace_id: "ws_1",
      })
    })

    it("trackSecondAgentCreated sends second_agent_created event", () => {
      trackSecondAgentCreated({ total_agents: 2 })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "second_agent_created",
        total_agents: 2,
      })
    })

    it("trackAgentLinkCreated sends agent_link_created event", () => {
      trackAgentLinkCreated({ source_agent: "ag_1", target_agent: "ag_2" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "agent_link_created",
        source_agent: "ag_1",
        target_agent: "ag_2",
      })
    })

    it("trackRuntimeConnected sends runtime_connected event", () => {
      trackRuntimeConnected({ runtime_type: "desktop" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "runtime_connected",
        runtime_type: "desktop",
      })
    })
  })

  describe("P3 — Page-Level Behavior", () => {
    it("trackLandingCtaClicked sends landing_cta_clicked event", () => {
      trackLandingCtaClicked({ cta_name: "get_started" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "landing_cta_clicked",
        cta_name: "get_started",
      })
    })

    it("trackTemplatesBrowsed sends templates_browsed event", () => {
      trackTemplatesBrowsed({ category_filter: "Engineering" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "templates_browsed",
        category_filter: "Engineering",
      })
    })

    it("trackSettingsUpdated sends settings_updated event", () => {
      trackSettingsUpdated({ setting_tab: "general" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "settings_updated",
        setting_tab: "general",
      })
    })

    it("trackCanvasLayoutChanged sends canvas_layout_changed event", () => {
      trackCanvasLayoutChanged({ layout_type: "tree" })
      expect(mockSendGTMEvent).toHaveBeenCalledWith({
        event: "canvas_layout_changed",
        layout_type: "tree",
      })
    })
  })
})
