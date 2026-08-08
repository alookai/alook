import { describe, expect, it } from "vitest"
import { encodeForumActivityCursor, parseForumActivityCursor } from "./forum-activity"

describe("forum activity cursor", () => {
  const value = {
    parentChannelId: "forum_1",
    activityAt: "2026-08-08T02:00:00.123Z",
    id: "thread_2",
    tag: "产品",
  }

  it("round-trips an opaque cursor within the same forum and tag scope", () => {
    const encoded = encodeForumActivityCursor(value)
    expect(encoded).not.toContain("forum_1")
    expect(parseForumActivityCursor(encoded, {
      parentChannelId: "forum_1",
      tag: "产品",
    })).toEqual({
      activityAt: "2026-08-08T02:00:00.123Z",
      id: "thread_2",
    })
  })

  it("rejects malformed, cross-forum, and cross-tag cursors", () => {
    const encoded = encodeForumActivityCursor(value)
    expect(parseForumActivityCursor("invalid", { parentChannelId: "forum_1", tag: "产品" })).toBeNull()
    expect(parseForumActivityCursor(encoded, { parentChannelId: "forum_2", tag: "产品" })).toBeNull()
    expect(parseForumActivityCursor(encoded, { parentChannelId: "forum_1", tag: "bug" })).toBeNull()
  })

  it("treats an absent cursor as the first page", () => {
    expect(parseForumActivityCursor(null, { parentChannelId: "forum_1", tag: null })).toBeUndefined()
  })
})
