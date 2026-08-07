import { describe, expect, it } from "vitest"
import { resolveChannelDisplayName } from "./channel-display-name"

describe("resolveChannelDisplayName", () => {
  it("uses opener content for a forum post instead of the copied child channel name", () => {
    expect(resolveChannelDisplayName({
      forumPostTitle: "Edited post title",
      childChannelName: "stale-created-title",
    })).toBe("Edited post title")
  })

  it("does not expose a stale child channel name while the opener is unavailable", () => {
    expect(resolveChannelDisplayName({
      childChannelName: null,
      fallback: "Post",
    })).toBe("Post")
  })

  it("keeps ordinary thread renames local-first", () => {
    expect(resolveChannelDisplayName({
      localName: "Renamed thread",
      childChannelName: "old-thread-name",
    })).toBe("Renamed thread")
  })
})
