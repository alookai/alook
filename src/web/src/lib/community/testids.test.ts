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

  it("exposes only the four stable My Bots bug-report flow selectors", () => {
    expect(tid.botReportProblemItem).toBe("bot-report-problem-item")
    expect(tid.botReportProblemDialog).toBe("bot-report-problem-dialog")
    expect(tid.botReportProblemSubmit).toBe("bot-report-problem-submit")
    expect(tid.botReportProblemStatus).toBe("bot-report-problem-status")
  })
})
