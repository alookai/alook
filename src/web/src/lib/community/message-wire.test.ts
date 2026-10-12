import { describe, expect, it } from "vitest"
import type { CommunityMessageCreate } from "@alook/shared"
import { presentCanonicalMessage, projectCommunityMessageCreate, projectPostedMessage } from "./message-wire"

function wire(
  overrides: Partial<CommunityMessageCreate["message"]> = {},
): CommunityMessageCreate["message"] {
  return {
    id: "m1",
    seq: 42,
    authorId: "u1",
    authorName: "Gus",
    authorAvatarVersion: 0,
    content: "hello",
    type: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  }
}

describe("projectCommunityMessageCreate", () => {
  it("presents sparse thread participants without altering stored facts", () => {
    const thread = { id: "thread", name: null, messageCount: 2, lastReplyAt: null, participants: [
      { id: "unknown" },
      { id: "initial", name: "Peer", avatar: null },
      { id: "known", name: "Author", avatar: "/avatar", avatarVersion: 4 },
    ] }
    expect(presentCanonicalMessage({ id: "opener", type: "chat", thread }).thread).toEqual({
      id: "thread", name: "", messageCount: 2, lastReplyAt: undefined, participants: [
        { id: "unknown", name: "", avatar: "?", avatarVersion: 0 },
        { id: "initial", name: "Peer", avatar: "P", avatarVersion: 0 },
        { id: "known", name: "Author", avatar: "/avatar", avatarVersion: 4 },
      ],
    })
    expect(thread.participants[0]).toEqual({ id: "unknown" })
    expect(thread.participants[1].avatar).toBeNull()
  })
  it("keeps explicit empty rich fields distinct from omission", () => {
    expect(projectCommunityMessageCreate(wire({ attachments: [], embeds: [] }), "channel-1"))
      .toMatchObject({ attachments: [], embeds: [] })
    const sparse = projectCommunityMessageCreate(wire(), "channel-1")
    expect(sparse).not.toHaveProperty("attachments")
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
        { id: "a1", filename: "photo.png", url: "/photo", contentType: "image/png", size: 2048, width: 640, height: 480 },
        { id: "a2", filename: "doc.pdf", url: "/doc", contentType: "application/pdf", size: 2048 },
        { id: "a3", filename: "unsafe.svg", url: "/unsafe", contentType: "image/svg+xml", size: 1024 },
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
  it.each([0, 46])("keeps valid legacy POST facts at seq %s without storage extras", (seq) => {
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

    expect(projectPostedMessage(row, "accepted-nonce", "channel-1")).toEqual({
      id: row.id, channelId: row.channelId, seq, authorId: row.authorId, authorName: row.authorName,
      authorAvatar: null, authorAvatarVersion: 4, createdAt: row.createdAt, content: row.content, type: "chat",
      mentionType: null, replyToId: replyTo.id, replyTo, attachments, embeds, reactions, thread,
      clientNonce: "accepted-nonce", resourceComplete: false,
    })
  })

  it.each([{ seq: undefined }, { seq: -1 }, { seq: 0.5 },
    { replyTo: { id: "prior", authorName: "Peer", text: "quoted", extra: true } },
  ])("rejects malformed known legacy POST facts %j", (fields) => {
    const row = { id: "legacy", seq: 1, authorId: "author", authorName: "Author", authorImage: null,
      authorAvatarVersion: 0, createdAt: "2026-10-07T12:00:00Z", content: "body", type: "default", embeds: null }
    expect(() => projectPostedMessage(Object.assign({}, row, fields), "nonce", "channel-1")).toThrow()
  })

  it("keeps full POST resource and confirmation requirements", () => {
    const full = { id: "full", channelId: "channel-1", seq: 47, authorId: "author", authorName: "Author",
      authorAvatar: null, authorAvatarVersion: 4, createdAt: "2026-10-07T12:00:00Z", content: "body", type: "chat" as const,
      replyToId: null, clientNonce: "nonce", attachments: [], resourceComplete: true as const }
    expect(projectPostedMessage(full, "nonce", "channel-1")).toEqual(full)
    for (const fields of [{ attachments: undefined }, { channelId: "foreign" }, { clientNonce: "foreign" }]) {
      expect(() => projectPostedMessage(Object.assign({}, full, fields), "nonce", "channel-1")).toThrow()
    }
  })

  it("falls back to an initial when the posted author has no canonical avatar", () => {
    const projected = projectPostedMessage({
      id: "m2",
      seq: 43,
      authorId: "u2",
      authorName: "Gus",
      authorImage: null,
      authorAvatarVersion: 0,
      content: "hello",
      type: "default",
      embeds: null,
      createdAt: "2026-08-06T00:00:00.000Z",
    }, "nonce-2", "dm-1")

    expect(projected).toMatchObject({
      authorAvatar: null,
      authorAvatarVersion: 0,
      clientNonce: "nonce-2",
    })
    expect(presentCanonicalMessage(projected).authorAvatar).toBe("G")
  })

  it("rejects an absent or mismatched actual POST channel scope", () => {
    const row = { id: "m3", seq: 44, authorId: "u3", authorName: "Peer", authorImage: null,
      authorAvatarVersion: 0, content: null, type: "default", embeds: null, createdAt: "2026-08-06T00:00:00.000Z" }
    expect(() => projectPostedMessage(row, "nonce-3", "")).toThrow()
    expect(() => projectPostedMessage(Object.assign({}, row, { channelId: "other" }), "nonce-3", "dm-1"))
      .toThrow("Message resource scope mismatch")
    expect(projectPostedMessage(row, "nonce-3", "dm-1")).toMatchObject({ id: "m3", content: "", type: "chat" })
  })

  it("keeps absent POST and WS rich content sparse", () => {
    const row = { id: "m4", seq: 45, authorId: "u4", authorName: "Peer", authorImage: null,
      authorAvatarVersion: 0, content: "plain", type: "default", embeds: null, createdAt: "2026-08-06T00:00:00.000Z" }
    const posted = projectPostedMessage(row, "nonce-4", "dm-1")
    expect(projectPostedMessage(Object.assign({}, row, { attachments: [], embeds: [] }), "nonce-4", "dm-1"))
      .toMatchObject({ attachments: [], embeds: [] })
    for (const message of [posted, projectCommunityMessageCreate(wire(), "channel-1")]) {
      expect(message).not.toHaveProperty("attachments")
      expect(message).not.toHaveProperty("embeds")
      expect(message.channelId).toBe(message.id === "m4" ? "dm-1" : "channel-1")
      expect(message).not.toHaveProperty("replyToId")
      expect(message).not.toHaveProperty("replyTo")
    }
  })

})
