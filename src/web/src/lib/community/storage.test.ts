import { describe, it, expect } from "vitest"
import {
  buildUserAvatarKey,
  buildBotAvatarKey,
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
