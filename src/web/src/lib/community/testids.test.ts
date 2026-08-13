import { describe, expect, it } from "vitest"
import { tid } from "./testids"

describe("community QA selectors", () => {
  it("keys forum-title read models by their stable child identity", () => {
    expect(tid.inboxUnreadChild("post_1")).toBe("community-inbox-unread-child-post_1")
    expect(tid.channelRefPill("post_1")).toBe("community-channel-ref-pill-post_1")
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
  })

  it("exposes attachment preview selectors from one canonical map", () => {
    expect(tid.attachmentCard("notes.md")).toBe("community-attachment-card-notes.md")
    expect(tid.attachmentPreviewSheet).toBe("community-attachment-preview-sheet")
    expect(tid.attachmentPreviewDownload).toBe("community-attachment-preview-download")
    expect(tid.attachmentPreviewContent).toBe("community-attachment-preview-content")
  })

  it("exposes only the four stable My Bots bug-report flow selectors", () => {
    expect(tid.botReportProblemItem).toBe("bot-report-problem-item")
    expect(tid.botReportProblemDialog).toBe("bot-report-problem-dialog")
    expect(tid.botReportProblemSubmit).toBe("bot-report-problem-submit")
    expect(tid.botReportProblemStatus).toBe("bot-report-problem-status")
  })
})
