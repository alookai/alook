import { describe, expect, it } from "vitest"
import { CommunityChannelResourceSchema, CommunityMessageResourceSchema, normalizeCommunityChannelResource, normalizeCommunityMessageResource } from "../src"

describe("common community resources", () => {
  it.each(["text", "forum", "thread", "dm"] as const)("normalizes the %s channel without inventing an owner", (type) => {
    const channel = normalizeCommunityChannelResource({ id: "channel", type, serverId: type === "dm" ? null : "server", name: type === "dm" ? null : "Channel",
      archived: 0, createdAt: "2026-10-07T12:00:00Z" })
    expect(channel).toMatchObject({ type, archived: false, parentChannelId: null, parentMessageId: null, categoryId: null, creatorId: null, lastMessageAt: null, messageCount: 0 })
    expect(CommunityChannelResourceSchema.safeParse({ ...channel, pending: true }).success).toBe(false)
  })
  it("requires committed message identity and rejects foreign scope", () => {
    const message = { id: "message", seq: 1, authorId: "author", createdAt: "2026-10-07T12:00:00Z", type: "chat", content: "hello" }
    expect(normalizeCommunityMessageResource(message, "channel")).toMatchObject({ channelId: "channel", replyToId: null, clientNonce: null, attachments: [] })
    expect(() => normalizeCommunityMessageResource({ ...message, channelId: "other" }, "channel")).toThrow("scope mismatch")
    expect(() => normalizeCommunityMessageResource({ ...message, seq: undefined }, "channel")).toThrow()
    const normalized = normalizeCommunityMessageResource(message, "channel")
    expect(CommunityMessageResourceSchema.safeParse({ ...normalized, type: "pending" }).success).toBe(false)
  })
})
