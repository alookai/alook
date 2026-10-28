import { messageResourceFixture } from "@/test/community-resource-fixtures"
import { describe, expect, it } from "vitest"
import type { CommunityMessageCreate } from "@alook/shared"
import { presentCanonicalMessage, projectCommunityMessageCreate, projectPostedMessage } from "./message-wire"

function wire(
  overrides: Partial<CommunityMessageCreate["message"]> = {},
): CommunityMessageCreate["message"] {
  return messageResourceFixture({
    channelId: "channel-1",
    id: "m1",
    seq: 42,
    authorId: "u1",
    authorName: "Gus",
    authorAvatarVersion: 0,
    content: "hello",
    type: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  })
}

describe("projectCommunityMessageCreate", () => {
  it("presents full thread participants without altering stored facts", () => {
    const thread = { id: "thread", name: null, messageCount: 2, lastReplyAt: null, participants: [
      { id: "unknown", name: "", avatar: null, avatarVersion: 0 },
      { id: "initial", name: "Peer", avatar: null, avatarVersion: 0 },
      { id: "known", name: "Author", avatar: "/avatar", avatarVersion: 4 },
    ] }
    expect(presentCanonicalMessage(wire({ id: "opener", thread })).thread).toEqual({
      id: "thread", name: null, messageCount: 2, lastReplyAt: null, participants: [
        { id: "unknown", name: "", avatar: "?", avatarVersion: 0 },
        { id: "initial", name: "Peer", avatar: "P", avatarVersion: 0 },
        { id: "known", name: "Author", avatar: "/avatar", avatarVersion: 4 },
      ],
    })
    expect(thread.participants[0]).toEqual({ id: "unknown", name: "", avatar: null, avatarVersion: 0 })
    expect(thread.participants[1].avatar).toBeNull()
  })
  it("requires full attachments and keeps optional embeds distinct from omission", () => {
    expect(projectCommunityMessageCreate(wire({ attachments: [], embeds: [] }), "channel-1"))
      .toMatchObject({ attachments: [], embeds: [] })
    const sparse = projectCommunityMessageCreate(wire(), "channel-1")
    expect(sparse.attachments).toEqual([])
    expect(() => projectCommunityMessageCreate(Object.assign({}, wire(), { attachments: undefined }), "channel-1")).toThrow()
    expect(sparse).not.toHaveProperty("embeds")
  })
  it("preserves canonical identity and presentation fields", () => {
    const replyTo = { id: "m0", authorName: "A", text: "prior" }
    const approval = {
      friendshipId: "f1",
      status: "pending" as const,
      waitingOn: "you" as const,
      otherProfile: { id: "u2", name: "Other", discriminator: "0002", image: null, avatarVersion: 0 },
      botProfile: { id: "b1", name: "Bot", discriminator: "0003", image: null, avatarVersion: 0 },
    }
    const projected = projectCommunityMessageCreate(wire({
      clientNonce: "nonce",
      type: "system",
      systemKind: "thread",
      authorAvatar: "avatar",
      replyTo,
      approval,
    }), "channel-1")
    expect(projected).toEqual(expect.objectContaining({
      id: "m1",
      seq: 42,
      clientNonce: "nonce",
      type: "system",
      systemKind: "thread",
      authorId: "u1",
      authorName: "Gus",
      authorAvatar: "avatar",
      content: "hello",
      createdAt: "2026-08-06T00:00:00.000Z",
      replyTo,
      approval,
    }))
    expect(() => projectCommunityMessageCreate(Object.assign({}, wire(), { storageMetadata: { legacy: true } }), "channel-1"))
      .toThrow()
  })

  it("keeps valid embed fields and omits an entirely malformed field list", () => {
    const raw = projectCommunityMessageCreate(wire({ embeds: [
      { title: "Mixed", fields: [null, { name: "Key", value: "Value", inline: true }, { name: "Missing value" }] },
      { title: "Invalid", fields: [null, { name: "Missing value" }] },
    ] }), "channel-1")
    const result = presentCanonicalMessage(raw)
    expect(raw.embeds?.[0]).toMatchObject({ fields: [null, { name: "Key", value: "Value", inline: true }, { name: "Missing value" }] })
    expect(result.embeds).toEqual([
      { title: "Mixed", fields: [{ name: "Key", value: "Value", inline: true }] },
      { title: "Invalid", fields: undefined },
    ])
  })
  it("narrows embeds and maps safe image/file attachments", () => {
    const raw = projectCommunityMessageCreate(wire({
      embeds: [{ title: "Card", url: "https://example.com" }, { url: "missing-title" }, null],
      attachments: [
        { id: "a1", name: "photo.png", url: "/photo", thumbnailUrl: null, contentType: "image/png", sizeBytes: 2048, width: 640, height: 480 },
        { id: "a2", name: "doc.pdf", url: "/doc", thumbnailUrl: null, contentType: "application/pdf", sizeBytes: 2048, width: null, height: null },
        { id: "a3", name: "unsafe.svg", url: "/unsafe", thumbnailUrl: null, contentType: "image/svg+xml", sizeBytes: 1024, width: null, height: null },
      ],
    }), "channel-1")
    const projected = presentCanonicalMessage(raw)
    expect(raw.attachments?.map((row) => row.id)).toEqual(["a1", "a2", "a3"])
    expect(raw.embeds).toHaveLength(3)
    expect(projected.embeds).toEqual([{ title: "Card", url: "https://example.com" }])
    expect(projected.attachments).toEqual([
      { kind: "image", name: "photo.png", url: "/photo", contentType: "image/png", sizeBytes: 2048, width: 640, height: 480 },
      { kind: "file", name: "doc.pdf", url: "/doc", contentType: "application/pdf", sizeBytes: 2048, size: "2.0 KB" },
      { kind: "file", name: "unsafe.svg", url: "/unsafe", contentType: "image/svg+xml", sizeBytes: 1024, size: "1.0 KB" },
    ])
  })
})

describe("projectPostedMessage", () => {
  it.each([0, 46])("rejects raw old POST storage rows at seq %s", (seq) => {
    const replyTo = { id: "prior", authorName: "Peer", text: "quoted" }
    const attachments = [{ id: "file", name: "file.txt", url: "/file", thumbnailUrl: null,
      contentType: "text/plain", sizeBytes: 4, width: null, height: null }]
    const embeds = [{ title: "Card" }]
    const reactions = [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }]
    const thread = { id: "thread", name: "Thread", messageCount: 1, lastReplyAt: null }
    const row = { id: "legacy", channelId: "channel-1", seq, authorId: "author", authorName: "Author",
      authorImage: null, authorAvatarVersion: 4, createdAt: "2026-10-07T12:00:00Z", content: "body", type: "default",
      mentionType: null, replyToId: replyTo.id, replyTo, attachments, embeds, reactions, thread,
      clientNonce: "stored-nonce", authorEmail: "legacy@example.test", storageMetadata: { legacy: true } }

    expect(() => projectPostedMessage(row, "accepted-nonce", "channel-1")).toThrow()
  })

  it.each([{ seq: undefined }, { seq: -1 }, { seq: 0.5 },
    { replyTo: { id: "prior", authorName: "Peer", text: "quoted", extra: true } },
  ])("rejects malformed current POST facts %j", (fields) => {
    const row = wire({ clientNonce: "nonce", authorId: "author", authorName: "Author" })
    expect(() => projectPostedMessage(Object.assign({}, row, fields), "nonce", "channel-1")).toThrow()
  })

  it("keeps full POST resource and confirmation requirements", () => {
    const full = { id: "full", channelId: "channel-1", seq: 47, authorId: "author", authorName: "Author",
      authorAvatar: null, authorAvatarVersion: 4, createdAt: "2026-10-07T12:00:00Z", content: "body", type: "chat" as const,
      replyToId: null, clientNonce: "nonce", attachments: [] }
    expect(projectPostedMessage(full, "nonce", "channel-1")).toEqual(full)
    for (const fields of [{ attachments: undefined }, { channelId: "foreign" }, { clientNonce: "foreign" }]) {
      expect(() => projectPostedMessage(Object.assign({}, full, fields), "nonce", "channel-1")).toThrow()
    }
  })

  it("falls back to an initial when the posted author has no canonical avatar", () => {
    const projected = projectPostedMessage(messageResourceFixture({
      id: "m2", channelId: "dm-1", seq: 43, clientNonce: "nonce-2", authorId: "u2", authorName: "Gus",
      authorAvatar: null, authorAvatarVersion: 0, content: "hello", createdAt: "2026-08-06T00:00:00.000Z",
    }), "nonce-2", "dm-1")
    expect(projected).toMatchObject({ authorAvatar: null, authorAvatarVersion: 0, clientNonce: "nonce-2" })
    expect(presentCanonicalMessage(projected).authorAvatar).toBe("G")
  })

  it("rejects an absent or mismatched actual POST channel scope", () => {
    const row = messageResourceFixture({ id: "m3", channelId: "dm-1", seq: 44, authorId: "u3", clientNonce: "nonce-3", content: "" })
    expect(() => projectPostedMessage(row, "nonce-3", "")).toThrow()
    expect(() => projectPostedMessage({ ...row, channelId: "other" }, "nonce-3", "dm-1"))
      .toThrow("Posted message confirmation mismatch")
    expect(projectPostedMessage(row, "nonce-3", "dm-1")).toEqual(row)
  })

  it("keeps required empty attachments and optional POST and WS rich content sparse", () => {
    const row = messageResourceFixture({ id: "m4", channelId: "dm-1", seq: 45, clientNonce: "nonce-4", authorId: "u4", content: "plain" })
    const posted = projectPostedMessage(row, "nonce-4", "dm-1")
    expect(projectPostedMessage({ ...row, attachments: [], embeds: [] }, "nonce-4", "dm-1"))
      .toMatchObject({ attachments: [], embeds: [] })
    for (const message of [posted, projectCommunityMessageCreate(wire(), "channel-1")]) {
      expect(message.attachments).toEqual([])
      expect(message).not.toHaveProperty("embeds")
      expect(message.channelId).toBe(message.id === "m4" ? "dm-1" : "channel-1")
      expect(message.replyToId).toBeNull()
      expect(message).not.toHaveProperty("replyTo")
    }
  })

  it.each([0, 46])("preserves all current POST rich facts at seq %s", (seq) => {
    const full = wire({ seq, clientNonce: "nonce", replyToId: "prior", replyTo: { id: "prior", authorName: "Peer", text: "quoted" },
      attachments: [{ id: "file", name: "file.txt", url: "/file", thumbnailUrl: null, contentType: "text/plain", sizeBytes: 4, width: null, height: null }],
      embeds: [{ title: "Card" }], reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }],
      thread: { id: "thread", name: "Thread", messageCount: 1, lastReplyAt: null },
    })
    expect(projectPostedMessage(full, "nonce", "channel-1")).toEqual(full)
  })
})
