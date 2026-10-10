import { describe, it, expect } from "vitest"
import {
  buildUserAvatarKey,
  buildUserAvatarObjectKey,
  buildBotAvatarKey,
  buildBotAvatarObjectKey,
  attachmentUrl,
  attachmentThumbnailUrl,
  ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
  sanitizeAttachmentFilename,
  userAvatarUrl,
  botAvatarUrl,
  isOwnedServerIconKey,
  isOwnedUserAvatarObjectKey,
  isOwnedBotAvatarObjectKey,
  canonicalUserImage,
  serverIconUrl,
} from "./storage"

describe("serverIconUrl", () => {
  it("uses the persisted object identity as a stable URL version", () => {
    const server = { id: "s1", icon: "server-icon/s1/object-one" }
    expect(serverIconUrl(server)).toBe("/api/community/servers/s1/icon?v=server-icon%2Fs1%2Fobject-one")
    expect(serverIconUrl({ ...server, icon: "server-icon/s1/object-two" })).not.toBe(serverIconUrl(server))
    expect(serverIconUrl({ ...server, icon: null })).toBeNull()
  })
})

describe("buildUserAvatarKey", () => {
  it("is deterministic (no randomness)", () => {
    expect(buildUserAvatarKey("u1")).toBe(buildUserAvatarKey("u1"))
  })

  it("has the correct format", () => {
    expect(buildUserAvatarKey("u1")).toBe("user-avatar/u1")
  })
})

describe("user avatar object ownership", () => {
  it("separates the fixed alias from one owned immutable child", () => {
    expect(buildUserAvatarObjectKey("u1", "v1")).toBe("user-avatar/u1/objects/v1")
    expect(isOwnedUserAvatarObjectKey("user-avatar/u1/objects/v1", "u1")).toBe(true)
    expect(isOwnedUserAvatarObjectKey(buildUserAvatarKey("u1"), "u1")).toBe(false)
    expect(isOwnedUserAvatarObjectKey("user-avatar/u2/objects/v1", "u1")).toBe(false)
    expect(isOwnedUserAvatarObjectKey("user-avatar/u1/objects/nested/v1", "u1")).toBe(false)
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

describe("bot avatar object ownership", () => {
  it("separates the fixed alias from one owned immutable child", () => {
    expect(buildBotAvatarObjectKey("b1", "v1")).toBe("bot-avatar/b1/objects/v1")
    expect(isOwnedBotAvatarObjectKey("bot-avatar/b1/objects/v1", "b1")).toBe(true)
    expect(isOwnedBotAvatarObjectKey(buildBotAvatarKey("b1"), "b1")).toBe(false)
    expect(isOwnedBotAvatarObjectKey("bot-avatar/b2/objects/v1", "b1")).toBe(false)
  })
})

describe("userAvatarUrl", () => {
  it("has the correct format", () => {
    expect(userAvatarUrl("u1")).toBe("/api/community/users/u1/avatar")
    expect(userAvatarUrl("u1", 2)).toBe("/api/community/users/u1/avatar?v=2")
  })
})

describe("botAvatarUrl", () => {
  it("has the correct format", () => {
    expect(botAvatarUrl("b1")).toBe("/api/community/bots/b1/avatar")
    expect(botAvatarUrl("b1", 3)).toBe("/api/community/bots/b1/avatar?v=3")
  })
})

describe("canonicalUserImage", () => {
  it("versions owned avatar routes and leaves external images unchanged", () => {
    expect(canonicalUserImage("u1", userAvatarUrl("u1"), 4)).toBe(userAvatarUrl("u1", 4))
    expect(canonicalUserImage("b1", botAvatarUrl("b1"), 5)).toBe(botAvatarUrl("b1", 5))
    expect(canonicalUserImage("u1", "https://cdn.example/avatar.png", 6)).toBe(
      "https://cdn.example/avatar.png",
    )
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

describe("isOwnedServerIconKey", () => {
  it("accepts exactly one non-empty suffix under the expected server", () => {
    expect(isOwnedServerIconKey("server-icon/s1/icon-a", "s1")).toBe(true)
  })

  it.each([
    "server-icon/s1/",
    "server-icon/s1/nested/icon-a",
    "server-icon/other/icon-a",
    "/api/community/servers/s1/icon",
    "server-icon/s1",
  ])("rejects non-owned or non-canonical key %s", (key) => {
    expect(isOwnedServerIconKey(key, "s1")).toBe(false)
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


})

it("uses a private immutable cache policy for authorized attachment bytes", () => {
  expect(ATTACHMENT_PRIVATE_IMMUTABLE_CACHE).toBe("private, max-age=31536000, immutable")
})
