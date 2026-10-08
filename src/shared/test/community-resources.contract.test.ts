import { describe, expect, it } from "vitest"
import { CommunityChannelResourceSchema, CommunityMessageResourceSchema, normalizeCommunityChannelIdentity, normalizeCommunityChannelResource, normalizeCommunityMessageResource } from "../src"
import { COMMUNITY_CONTRACT_HEADER, requestsCommunityContractV2 } from "../src/community-contract"

describe("common community resources", () => {
  it.each([undefined, "1", "2", "02", "3"])("negotiates only the exact supported read contract %s", (version) => {
    const headers = new Headers(version === undefined ? undefined : { [COMMUNITY_CONTRACT_HEADER]: version })
    expect(requestsCommunityContractV2(headers)).toBe(version === "2")
  })
  it.each(["text", "forum", "thread", "dm"] as const)("normalizes the %s channel without inventing an owner", (type) => {
    const channel = normalizeCommunityChannelResource({ id: "channel", type, serverId: type === "dm" ? null : "server", name: type === "dm" ? null : "Channel",
      archived: 0, createdAt: "2026-10-07T12:00:00Z" })
    expect(channel).toMatchObject({ type, archived: false, parentChannelId: null, parentMessageId: null, categoryId: null, creatorId: null, lastMessageAt: null, messageCount: 0 })
    expect(CommunityChannelResourceSchema.safeParse({ ...channel, pending: true }).success).toBe(false)
  })
  it("validates legacy channel identity without requiring full-read fields", () => {
    const input = { id: "post", type: "thread", serverId: "server", name: "Post", archived: 1, extra: "legacy" }
    expect(normalizeCommunityChannelIdentity(input)).toEqual({ id: "post", type: "thread", serverId: "server", name: "Post", archived: true,
      parentChannelId: null, parentMessageId: null, creatorId: null, lastMessageAt: null })
    expect(() => normalizeCommunityChannelIdentity({ ...input, id: "" })).toThrow()
    expect(() => normalizeCommunityChannelIdentity({ ...input, archived: 2 })).toThrow()
  })
  it("requires committed message identity and rejects foreign scope", () => {
    const message = { id: "message", seq: 1, authorId: "author", createdAt: "2026-10-07T12:00:00Z", type: "chat", content: "hello" }
    expect(normalizeCommunityMessageResource(message, "channel")).toMatchObject({ channelId: "channel", replyToId: null, clientNonce: null, attachments: [] })
    expect(() => normalizeCommunityMessageResource({ ...message, channelId: "other" }, "channel")).toThrow("scope mismatch")
    expect(() => normalizeCommunityMessageResource({ ...message, seq: undefined }, "channel")).toThrow()
    const normalized = normalizeCommunityMessageResource(message, "channel")
    expect(CommunityMessageResourceSchema.safeParse({ ...normalized, type: "pending" }).success).toBe(false)
  })

  it("returns a complete canonical resource while stripping only legacy envelope extras", () => {
    const channel = normalizeCommunityChannelResource({ id: "channel", type: "thread", serverId: "server", name: null, archived: 1,
      createdAt: "now", topic: null, position: null, messageCount: null, extra: "legacy" })
    expect(CommunityChannelResourceSchema.parse(channel)).toEqual(channel)
    expect(channel).toMatchObject({ archived: true, topic: "", position: 0, messageCount: 0 })
    expect(channel).not.toHaveProperty("extra")
    const message = normalizeCommunityMessageResource({ id: "message", seq: 0, authorId: "author", createdAt: "now", type: "chat", content: "",
      replyToId: null, replyTo: { id: "reply", authorName: "Author", text: "prior" }, clientNonce: null, embeds: null, extra: "legacy" }, "channel")
    expect(CommunityMessageResourceSchema.parse(message)).toEqual(message)
    expect(message).toMatchObject({ replyToId: "reply", clientNonce: null, attachments: [] })
    expect(message).not.toHaveProperty("extra")
  })

  it.each([{ seq: -1 }, { seq: 0.5 }, { authorId: "" }, { attachments: null },
    { attachments: [{ kind: "file", name: "file", url: "/file", extra: true }] },
    { replyTo: { id: "reply", authorName: "Author", text: "prior", extra: true } },
  ])("rejects invalid committed message fields %j", (fields) => {
    expect(() => normalizeCommunityMessageResource({ id: "message", seq: 0, authorId: "author", createdAt: "now", type: "chat", content: "", ...fields }, "channel")).toThrow()
  })

  it("rejects an empty publication scope and invalid channel defaults", () => {
    expect(() => normalizeCommunityMessageResource({ id: "message", seq: 0, authorId: "author", createdAt: "now", type: "chat", content: "" }, "")).toThrow()
    for (const fields of [{ messageCount: -1 }, { messageCount: 0.5 }, { position: Infinity }, { archived: 2 }, { name: undefined }, { serverId: undefined }]) {
      expect(() => normalizeCommunityChannelResource({ id: "channel", type: "text", serverId: "server", name: "Channel", archived: 0, createdAt: "now", ...fields })).toThrow()
    }
  })
})
