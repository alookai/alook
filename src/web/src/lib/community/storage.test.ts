import { describe, it, expect } from "vitest"
import {
  buildMediaKey,
  buildUserAvatarKey,
  buildBotAvatarKey,
  mediaUrlFromKey,
  sanitizeAttachmentFilename,
  userAvatarUrl,
  botAvatarUrl,
} from "./storage"

describe("buildUserAvatarKey", () => {
  it("is deterministic (no randomness)", () => {
    expect(buildUserAvatarKey("u1")).toBe(buildUserAvatarKey("u1"))
  })

  it("has the correct format", () => {
    expect(buildUserAvatarKey("u1")).toBe("user-avatar/u1")
  })
})

describe("buildBotAvatarKey", () => {
  it("is deterministic (no randomness)", () => {
    expect(buildBotAvatarKey("b1")).toBe(buildBotAvatarKey("b1"))
  })

  it("has the correct format", () => {
    expect(buildBotAvatarKey("b1")).toBe("bot-avatar/b1")
  })
})

describe("userAvatarUrl", () => {
  it("has the correct format", () => {
    expect(userAvatarUrl("u1")).toBe("/api/community/users/u1/avatar")
  })
})

describe("botAvatarUrl", () => {
  it("has the correct format", () => {
    expect(botAvatarUrl("b1")).toBe("/api/community/bots/b1/avatar")
  })
})

describe("no collisions between user and bot avatar keys for the same id", () => {
  it("distinct R2 keys", () => {
    expect(buildUserAvatarKey("same-id")).not.toBe(buildBotAvatarKey("same-id"))
  })

  it("distinct routable URLs", () => {
    expect(userAvatarUrl("same-id")).not.toBe(botAvatarUrl("same-id"))
  })
})

describe("sanitizeAttachmentFilename", () => {
  it("strips traversal sequences", () => {
    // `..` collapses to `_` first, then `/` is replaced by `_`.
    expect(sanitizeAttachmentFilename("../evil.png")).toBe("__evil.png")
  })

  it("replaces path separators", () => {
    expect(sanitizeAttachmentFilename("a/b/c.png")).toBe("a_b_c.png")
  })

  it("replaces control characters", () => {
    expect(sanitizeAttachmentFilename("a\x01b\x7fc.png")).toBe("a_b_c.png")
  })

  it("caps length at 255", () => {
    const long = "x".repeat(300)
    expect(sanitizeAttachmentFilename(long).length).toBe(255)
  })

  it("falls back to _ when the input is empty", () => {
    expect(sanitizeAttachmentFilename("")).toBe("_")
  })
})

describe("buildMediaKey", () => {
  it("emits keys with no leading slash and the sanitized filename component", () => {
    const key = buildMediaKey("channel", "c1", "uuid", "../evil.png")
    expect(key.startsWith("/")).toBe(false)
    expect(key).toBe("channel/c1/uuid/__evil.png")
  })
})

describe("mediaUrlFromKey", () => {
  it("prepends the media route prefix without adding a slash", () => {
    expect(mediaUrlFromKey("channel/c1/uuid/a.png")).toBe("/api/community/media/channel/c1/uuid/a.png")
  })
})
