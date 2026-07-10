import { describe, it, expect } from "vitest"
import { CommunityBotCreateRequestSchema, CommunityBotPatchRequestSchema } from "./schemas"

function validCreatePayload(image?: string) {
  return {
    name: "MyBot",
    machineId: "m1",
    runtime: "node",
    ...(image !== undefined ? { image } : {}),
  }
}

describe("BotImageUrlSchema (via CommunityBotCreateRequestSchema)", () => {
  it("accepts an https URL", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("https://cdn.example.com/a.png"))
    expect(res.success).toBe(true)
  })

  it("accepts an avatar: procedural config", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("avatar:shape=star"))
    expect(res.success).toBe(true)
  })

  it("accepts a leading-/ routable path (bot-avatar upload route shape)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("/api/community/bots/b1/avatar"))
    expect(res.success).toBe(true)
  })

  it("rejects a bare (non-routable, non-https, non-avatar:) string", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("not-a-url"))
    expect(res.success).toBe(false)
  })

  it("rejects http:// (only https:// is allowed)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("http://cdn.example.com/a.png"))
    expect(res.success).toBe(false)
  })

  it("rejects a protocol-relative URL (starts with `/` but resolves off-origin)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("//evil.com/pixel.gif"))
    expect(res.success).toBe(false)
  })

  it("rejects an arbitrary same-origin path that isn't the bot avatar route", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("/some/internal/route"))
    expect(res.success).toBe(false)
  })

  it("rejects a bot avatar route for a different bot id shape (path traversal attempt)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(
      validCreatePayload("/api/community/bots/../../etc/passwd/avatar"),
    )
    expect(res.success).toBe(false)
  })

  it("image field remains optional", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload())
    expect(res.success).toBe(true)
  })
})

describe("BotImageUrlSchema (via CommunityBotPatchRequestSchema)", () => {
  it("accepts a leading-/ routable path", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: "/api/community/bots/b1/avatar" })
    expect(res.success).toBe(true)
  })

  it("still accepts null to clear the image", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: null })
    expect(res.success).toBe(true)
  })

  it("rejects an invalid image string", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: "ftp://nope" })
    expect(res.success).toBe(false)
  })
})
