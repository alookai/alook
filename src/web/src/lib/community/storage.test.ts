import { describe, it, expect } from "vitest"
import {
  buildMediaKey,
  buildUserAvatarKey,
  buildBotAvatarKey,
  attachmentUrl,
  attachmentThumbnailUrl,
  buildAttachmentThumbnailKey,
  ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
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

describe("attachmentUrl", () => {
  it("builds the id-addressed canonical attachments-door URL from targetId + attachmentId", () => {
    expect(attachmentUrl("c1", "att_1")).toBe("/api/community/channels/c1/attachments/att_1")
  })
})

describe("attachment thumbnail addressing", () => {
  it("builds sibling canonical URLs", () => {
    expect(attachmentThumbnailUrl("c1", "att_1")).toBe(
      "/api/community/channels/c1/attachments/att_1/thumbnail",
    )
  })

  it("uses a reserved suffix on the complete original key", () => {
    expect(buildAttachmentThumbnailKey("channel/c1/id/thumbnail.jpg")).toBe(
      "channel/c1/id/thumbnail.jpg.thumbnail.jpg",
    )
  })
})

it("uses a private immutable cache policy for authorized attachment bytes", () => {
  expect(ATTACHMENT_PRIVATE_IMMUTABLE_CACHE).toBe("private, max-age=31536000, immutable")
})
