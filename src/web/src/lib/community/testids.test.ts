import { describe, expect, it } from "vitest"
import { tid } from "./testids"

describe("community QA selectors", () => {
  it("exposes the global reconnect overlay independently from its Retry action", () => {
    expect(tid.wsReconnectOverlay).toBe("community-ws-reconnect-overlay")
    expect(tid.wsRetry).toBe("community-ws-retry")
  })

  it("keys forum-title read models by their stable child identity", () => {
    expect(tid.inboxUnreadChild("post_1")).toBe("community-inbox-unread-child-post_1")
    expect(tid.inboxUnreadChannel("channel_1")).toBe("community-inbox-unread-channel-channel_1")
    expect(tid.channelRefPill("post_1")).toBe("community-channel-ref-pill-post_1")
    expect(tid.channelRefOption("channel_1")).toBe("community-channel-ref-option-channel_1")
    expect(tid.channelRefPopup).toBe("community-channel-ref-popup")
    expect(tid.channelRefStatus).toBe("community-channel-ref-status")
  })

  it("keys invite-card surfaces by their token", () => {
    expect(tid.inviteCard("invite_1")).toBe("community-invite-card-invite_1")
    expect(tid.inviteCardAction("invite_1")).toBe(
      "community-invite-card-action-invite_1",
    )
  })

  it("exposes the profile context badge independently from the card", () => {
    expect(tid.profileCard).toBe("community-profile-card")
    expect(tid.profileContextBadge).toBe("community-profile-context-badge")
    expect(tid.profileBotBadge).toBe("community-profile-bot-badge")
    expect(tid.profileOwnerLink).toBe("community-profile-owner-link")
    expect(tid.botAuditPreview).toBe("community-bot-audit-preview")
    expect(tid.botAuditPreviewDock).toBe("community-bot-audit-preview-dock")
    expect(tid.botAuditPreviewActive).toBe("community-bot-audit-preview-active")
    expect(tid.botActivityModal).toBe("bot-activity-modal")
    expect(tid.botAuditPreviewRow("event_1")).toBe(
      "community-bot-audit-preview-row-event_1",
    )
  })

  it("exposes stable composer and message-list surfaces", () => {
    expect(tid.channelComposerShell).toBe("community-composer-shell")
    expect(tid.memberRow("member_1")).toBe("community-member-row-member_1")
    expect(tid.composerFileInput).toBe("community-composer-file-input")
    expect(tid.messageScroller).toBe("community-message-scroller")
    expect(tid.reactionGroup("message_1")).toBe("community-reaction-group-message_1")
    expect(tid.reactionChip("message_1", "🔥"))
      .toBe("community-reaction-chip-message_1-%F0%9F%94%A5")
    expect(tid.reactionDialog("message_1")).toBe("community-reaction-dialog-message_1")
    expect(tid.reactionTab("👍")).toBe("community-reaction-tab-%F0%9F%91%8D")
    expect(tid.reactionMember("user_1")).toBe("community-reaction-member-user_1")
    expect(tid.reactionScroller("message_1")).toBe("community-reaction-scroller-message_1")
    expect(tid.reactionFadeLeft("message_1")).toBe("community-reaction-fade-left-message_1")
    expect(tid.reactionFadeRight("message_1")).toBe("community-reaction-fade-right-message_1")
    expect(tid.reactionEmpty("message_1")).toBe("community-reaction-empty-message_1")
  })

  it("keys a pending channel sidebar by its target server", () => {
    expect(tid.channelSidebarPending("server_1"))
      .toBe("community-channel-sidebar-pending-server_1")
    expect(tid.dmSidebarPending).toBe("community-dm-sidebar-pending")
  })

  it("exposes attachment preview selectors from one canonical map", () => {
    expect(tid.attachmentCard("notes.md")).toBe("community-attachment-card-notes.md")
    expect(tid.attachmentPreviewSheet).toBe("community-attachment-preview-sheet")
    expect(tid.attachmentPreviewDownload).toBe("community-attachment-preview-download")
    expect(tid.attachmentPreviewContent).toBe("community-attachment-preview-content")
    expect(tid.mediaBlock("clip.mp4")).toBe("community-media-block-clip.mp4")
    expect(tid.mediaPlay("clip.mp4")).toBe("community-media-play-clip.mp4")
    expect(tid.mediaPlayer("clip.mp4")).toBe("community-media-player-clip.mp4")
    expect(tid.mediaCollapse("clip.mp4")).toBe("community-media-collapse-clip.mp4")
    expect(tid.mediaDownload("clip.mp4")).toBe("community-media-download-clip.mp4")
    expect(tid.mediaRetry("clip.mp4")).toBe("community-media-retry-clip.mp4")
    expect(tid.mediaStatus("clip.mp4")).toBe("community-media-status-clip.mp4")
  })

  it("exposes only the four stable My Bots bug-report flow selectors", () => {
    expect(tid.botReportProblemItem).toBe("bot-report-problem-item")
    expect(tid.botReportProblemDialog).toBe("bot-report-problem-dialog")
    expect(tid.botReportProblemSubmit).toBe("bot-report-problem-submit")
    expect(tid.botReportProblemStatus).toBe("bot-report-problem-status")
  })
})
