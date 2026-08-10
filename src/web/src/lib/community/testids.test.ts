import { describe, expect, it } from "vitest"
import { tid } from "./testids"

describe("community QA selectors", () => {
  it("keys forum-title read models by their stable child identity", () => {
    expect(tid.inboxUnreadChild("post_1")).toBe("community-inbox-unread-child-post_1")
    expect(tid.channelRefPill("post_1")).toBe("community-channel-ref-pill-post_1")
  })
})
