import { describe, expect, it } from "vitest"
import { encodeForumCreatedAtCursor, parseForumCreatedAtCursor } from "./forum-feed-cursor"

describe("forum created-at cursor", () => {
  const value = {
    parentChannelId: "forum_1",
    createdAt: "2026-08-08T02:00:00.123Z",
    id: "thread_2",
    tag: "产品",
  }

  it("round-trips an opaque cursor within the same forum and tag scope", () => {
    const encoded = encodeForumCreatedAtCursor(value)
    expect(encoded).not.toContain("forum_1")
    expect(parseForumCreatedAtCursor(encoded, {
      parentChannelId: "forum_1",
      tag: "产品",
    })).toEqual({
      createdAt: "2026-08-08T02:00:00.123Z",
      id: "thread_2",
    })
  })

  it("rejects malformed, cross-forum, and cross-tag cursors", () => {
    const encoded = encodeForumCreatedAtCursor(value)
    expect(parseForumCreatedAtCursor("invalid", { parentChannelId: "forum_1", tag: "产品" })).toBeNull()
    expect(parseForumCreatedAtCursor(encoded, { parentChannelId: "forum_2", tag: "产品" })).toBeNull()
    expect(parseForumCreatedAtCursor(encoded, { parentChannelId: "forum_1", tag: "bug" })).toBeNull()
  })

  it("treats an absent cursor as the first page", () => {
    expect(parseForumCreatedAtCursor(null, { parentChannelId: "forum_1", tag: null })).toBeUndefined()
  })
})
