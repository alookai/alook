import { describe, expect, it } from "vitest"
import { communityMessagePreviewFromLegacy, CommunityLegacyMessageResourceSchema, communityChannelResourceFromStorage, CommunityMessageAttachmentSchema, CommunityMessagePreviewSchema, CommunityResourceProfileSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema, normalizeCommunityChannelIdentity, normalizeCommunityChannelResource, normalizeCommunityChannelResourcePreview, normalizeCommunityMessageResource } from "../src"
import { communityResourceChannelFixture, communityResourceMessageFixture } from "./community-ws-events.fixtures"
import { COMMUNITY_CONTRACT_HEADER, requestsCommunityContract } from "../src/community-contract"
import { CommunityConversationEntryReadSchema, communityReadSchemas, type CommunityChannelResource } from "../src/community-resources"

describe("common community resources", () => {
  it.each([2, 3] as const)("selects read contract %s without accepting the other version", (contractVersion) => {
    const schemas = communityReadSchemas(contractVersion)
    const body = { contractVersion, channelId: "channel", changed: true, targetSeq: 7, revision: 9 }
    expect(schemas.readAdvance.parse(body)).toEqual(body)
    expect(schemas.readAdvance.safeParse({ ...body, contractVersion: contractVersion === 2 ? 3 : 2 }).success).toBe(false)
    expect(schemas.error.parse({ contractVersion, error: { code: "not_allowed", message: "Denied", retryable: false } }))
      .toEqual({ contractVersion, error: { code: "not_allowed", message: "Denied", retryable: false } })
  })
  it.each([undefined, "1", "2", "02", "3"])("negotiates only the exact supported read contract %s", (version) => {
    const headers = new Headers(version === undefined ? undefined : { [COMMUNITY_CONTRACT_HEADER]: version })
    expect(requestsCommunityContract(headers)).toBe(version === "2" || version === "3")
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
  it.each([[false, false], [true, true], [0, false], [1, true]] as const)("normalizes only the present preview archive fact %s", (archived, expected) => {
    expect(normalizeCommunityChannelResourcePreview({ id: "preview", archived })).toEqual({ id: "preview", archived: expected })
  })
  it("keeps omitted preview fields absent", () => {
    const input = { id: "preview", name: "Preview" }
    expect(normalizeCommunityChannelResourcePreview(input)).toEqual(input)
    expect(normalizeCommunityChannelResourcePreview({})).toEqual({})
  })
  it("preserves supplied preview facts without complete or authority markers", () => {
    const input = { ...communityResourceChannelFixture, name: null, categoryId: "category", creatorId: null, lastMessageAt: "last", messageCount: 7, archived: 1 }
    expect(normalizeCommunityChannelResourcePreview({ ...input, resourceComplete: true, contractVersion: 3, accessDecision: { canRead: true }, proof: { revision: 7 } }))
      .toEqual({ ...input, archived: true })
  })
  it.each([{ archived: 2 }, { archived: -1 }, { archived: "0" }, { archived: "true" }, { archived: null }, { topic: null },
    { messageCount: -1 }, { messageCount: 0.5 }, { position: Infinity }, { id: "" },
  ])("rejects malformed supplied preview facts %j", (fields) => {
    expect(() => normalizeCommunityChannelResourcePreview({ id: "preview", ...fields })).toThrow()
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

describe("conversation entry resource", () => {
  const entry = () => ({
    contractVersion: 3,
    channelId: communityResourceChannelFixture.id,
    viewerId: "viewer", peer: null,
    channel: communityResourceChannelFixture,
    access: { channelId: communityResourceChannelFixture.id, canRead: true, canSend: true, canCreateDiscussion: false },
    readState: { channelId: communityResourceChannelFixture.id, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
    messages: [],
    page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 },
    surfaceReceipt: { channelId: communityResourceChannelFixture.id, surfaceKind: "channel" },
    readStateRevision: 0, selection: { reason: "tail", anchorMessageId: null },
  })


  const forumEntry = () => {
    const value = entry()
    const channel: CommunityChannelResource = { ...value.channel, type: "forum" }
    const child = { ...channel, id: "child", type: "thread" as const, parentChannelId: channel.id, parentMessageId: "opener" }
    const opener = { ...communityResourceMessageFixture.message, id: "opener", channelId: channel.id }
    const message = { ...opener, id: "reply", channelId: child.id }
    return { ...value, channel, surfaceReceipt: { ...value.surfaceReceipt, surfaceKind: "forum" }, forumFeed: {
      contractVersion: 3, channelId: channel.id, channel, threads: [child],
      included: { messages: [opener, message], tags: [{ messageId: "opener", tag: "tag" }], participantCounts: [{ channelId: child.id, count: 1 }],
        profiles: [{ id: "peer", name: "Peer", discriminator: "1234", avatar: null, avatarVersion: 0 }],
        members: [{ channelId: child.id, userId: "peer", relation: "notify", source: "added", isCreator: false, role: null, memberId: null }] },
      page: { nextCursor: null, hasMore: false },
    } }
  }

  it("accepts a complete forum entry with opener, child messages and matching notification profiles", () => {
    const value = forumEntry()
    expect(CommunityConversationEntryReadSchema.parse(value)).toEqual(value)
  })

  it.each(["feed-server", "thread-parent", "thread-server", "message", "tag", "count", "member-channel", "member-relation", "member-profile"] as const)("rejects foreign forum included scope: %s", kind => {
    const value = forumEntry()
    const feed = value.forumFeed
    if (kind === "feed-server") feed.channel = { ...feed.channel, serverId: "foreign" }
    if (kind === "thread-parent") feed.threads[0].parentChannelId = "foreign"
    if (kind === "thread-server") feed.threads[0].serverId = "foreign"
    if (kind === "message") feed.included.messages[1].channelId = "foreign"
    if (kind === "tag") feed.included.tags[0].messageId = "foreign"
    if (kind === "count") feed.included.participantCounts[0].channelId = "foreign"
    if (kind === "member-channel") feed.included.members[0].channelId = "foreign"
    if (kind === "member-relation") feed.included.members[0].relation = "access"
    if (kind === "member-profile") feed.included.profiles = []
    const result = CommunityConversationEntryReadSchema.safeParse(value)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.some(issue => issue.code === "custom" && issue.path[0] === "forumFeed")).toBe(true)
  })

  it("preserves a confirmed empty entry without inventing a read pointer", () => {
    const value = entry()
    expect(CommunityConversationEntryReadSchema.parse(value)).toEqual(value)
    expect(communityReadSchemas(3).messages.safeParse(value).success).toBe(false)
  })

  it.each(["channel", "access", "readState", "surfaceReceipt"] as const)("rejects a foreign %s in the entry", (field) => {
    const value = entry()
    const input = { ...value, [field]: { ...value[field], [field === "channel" ? "id" : "channelId"]: "foreign" } }
    expect(() => CommunityConversationEntryReadSchema.parse(input)).toThrow("scope mismatch")
  })

  it("rejects foreign message rows and a mismatching surface before publication", () => {
    const value = entry()
    const message = { ...communityResourceMessageFixture.message, channelId: "foreign" }
    expect(() => CommunityConversationEntryReadSchema.parse({ ...value, messages: [message] })).toThrow("scope mismatch")
    expect(() => CommunityConversationEntryReadSchema.parse({ ...value, surfaceReceipt: { ...value.surfaceReceipt, surfaceKind: "dm" } })).toThrow("surface mismatch")
  })

  it("requires current readable identity and the explicit entry contract", () => {
    const value = entry()
    for (const input of [
      { ...value, contractVersion: 2 }, { ...value, viewerId: "" },
      { ...value, channel: { ...value.channel, archived: true } },
      { ...value, access: { ...value.access, canRead: false } },
      { ...value, readProof: { restored: true } },
    ]) expect(CommunityConversationEntryReadSchema.safeParse(input).success).toBe(false)
  })

  it("distinguishes an explicit anchor, a current read anchor and a missing read anchor", () => {
    const value = entry()
    const readState = { ...value.readState, lastReadMessageId: "read", lastReadAt: "read-at", lastReadSeq: 4 }
    for (const selection of [
      { reason: "explicit_anchor", anchorMessageId: "deep-link" },
      { reason: "read_pointer", anchorMessageId: "read" },
      { reason: "read_pointer_missing", anchorMessageId: null },
    ]) expect(CommunityConversationEntryReadSchema.parse({ ...value, readState, selection }).selection).toEqual(selection)
    for (const selection of [
      { reason: "explicit_anchor", anchorMessageId: null },
      { reason: "read_pointer", anchorMessageId: "other" },
      { reason: "tail", anchorMessageId: "read" },
    ]) expect(CommunityConversationEntryReadSchema.safeParse({ ...value, readState, selection }).success).toBe(false)
    expect(CommunityConversationEntryReadSchema.safeParse({ ...value, selection: { reason: "read_pointer_missing", anchorMessageId: null } }).success).toBe(false)
  })
})


describe("full v3 resource facts", () => {
  it("preserves nullable metadata, IDs, order and raw embeds without presentation fields", () => {
    const value = JSON.parse(JSON.stringify(communityResourceMessageFixture.message))
    expect(CommunityMessageResourceSchema.parse(value)).toEqual(value)
    expect(CommunityMessageResourceSchema.parse(CommunityMessageResourceSchema.parse(value))).toEqual(value)
    expect(value.attachments.map((row: { id: string }) => row.id)).toEqual(["attachment-2", "attachment-1"])
    for (const key of ["id", "name", "url", "thumbnailUrl", "contentType", "sizeBytes", "width", "height"]) {
      const attachment = { ...value.attachments[0] }
      delete attachment[key]
      expect(CommunityMessageAttachmentSchema.safeParse(attachment).success).toBe(false)
    }
    for (const sizeBytes of [-1, 0.5, Infinity]) expect(CommunityMessageAttachmentSchema.safeParse({ ...value.attachments[0], sizeBytes }).success).toBe(false)
    expect(CommunityMessagePreviewSchema.parse({ id: "preview", type: "chat" })).toEqual({ id: "preview", type: "chat" })
    expect(CommunityMessageResourceSchema.safeParse({ id: "preview", type: "chat" }).success).toBe(false)
  })
  it("decodes only actual storage booleans and requires every full channel field", () => {
    const value = { ...communityResourceChannelFixture, archived: 0 }
    expect(communityChannelResourceFromStorage(value)).toEqual(communityResourceChannelFixture)
    for (const key of Object.keys(value)) {
      const incomplete: Record<string, unknown> = { ...value }
      delete incomplete[key]
      expect(() => communityChannelResourceFromStorage(incomplete)).toThrow()
    }
    expect(() => communityChannelResourceFromStorage({ ...value, archived: 2 })).toThrow()
    const profile = { id: "user-1", name: "Author", discriminator: "12345", avatar: null, avatarVersion: 0 }
    expect(CommunityResourceProfileSchema.parse(profile)).toEqual(profile)
    expect(CommunityResourceProfileSchema.parse(profile)).not.toHaveProperty("statusText")
  })
})


describe("nested resource and legacy preview boundaries", () => {
  it("keeps unknown legacy nonce and reply identity omitted", () => {
    const input = { id: "preview", seq: 1, authorId: "author", createdAt: "now", type: "chat", content: "body" }
    const preview = communityMessagePreviewFromLegacy(input, "channel")
    for (const field of ["clientNonce", "replyToId", "attachments"]) expect(preview).not.toHaveProperty(field)
    expect(communityMessagePreviewFromLegacy({ ...input, clientNonce: null, replyToId: null, attachments: [] }, "channel"))
      .toMatchObject({ clientNonce: null, replyToId: null, attachments: [] })
  })
  it("preserves actual nested NULLs only in full 3 and never stores a legacy initial as a fact", () => {
    const thread = { id: "thread", name: null, messageCount: 0, lastReplyAt: null, participants: [{ id: "peer", name: "Peer", avatar: null, avatarVersion: 4 }] }
    const message = { ...communityResourceMessageFixture.message, thread }
    expect(CommunityMessageResourceSchema.parse(message).thread).toEqual(thread)
    expect(CommunityLegacyMessageResourceSchema.safeParse({ ...message, attachments: [] }).success).toBe(false)
    const legacyThread = { ...thread, name: "Thread", lastReplyAt: "now", participants: [{ id: "peer", name: "Peer", avatar: "P", avatarVersion: 4 }] }
    const legacy = { ...message, authorAvatar: "A", attachments: [], thread: legacyThread }
    expect(CommunityLegacyMessageResourceSchema.parse(legacy).thread).toEqual(legacyThread)
    const preview = communityMessagePreviewFromLegacy(legacy, message.channelId)
    expect(preview.thread?.participants).toEqual([{ id: "peer", name: "Peer", avatarVersion: 4 }])
    for (const field of ["name", "avatar", "avatarVersion"]) {
      const participant: Record<string, unknown> = { ...thread.participants[0] }
      delete participant[field]
      expect(CommunityMessageResourceSchema.safeParse({ ...message, thread: { ...thread, participants: [participant] } }).success).toBe(false)
    }
  })
})
