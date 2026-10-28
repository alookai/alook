import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, communityChannelResourceFromStorage, CommunityMessageAttachmentSchema, CommunityResourceProfileSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema } from "../src"
import { communityResourceChannelFixture, communityResourceMessageFixture } from "./community-ws-events.fixtures"
import { COMMUNITY_CONTRACT_HEADER, requestsCommunityContract } from "../src/community-contract"
import { CommunityMessageResourcesSchema, communityMessageProfileIds, CommunityConversationEntryReadSchema, communityReadSchemas, type CommunityChannelResource } from "../src/community-resources"

describe("current community resources", () => {
  it("accepts only the exact current read contract", () => {
    const body = { contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", changed: true, targetSeq: 7, revision: 9 }
    expect(communityReadSchemas().readAdvance.parse(body)).toEqual(body)
    for (const version of [undefined, 1, 2, 3, BUSINESS_SCHEMA_VERSION + 1]) {
      expect(() => communityReadSchemas(version === undefined ? 0 : version)).toThrow("protocol mismatch")
      expect(communityReadSchemas().readAdvance.safeParse({ ...body, contractVersion: version }).success).toBe(false)
    }
  })
  it.each([undefined, "1", "2", "02", "3", String(BUSINESS_SCHEMA_VERSION), `0${BUSINESS_SCHEMA_VERSION}`])("requires exact header %s", version => {
    expect(requestsCommunityContract(new Headers(version === undefined ? {} : { [COMMUNITY_CONTRACT_HEADER]: version }))).toBe(version === String(BUSINESS_SCHEMA_VERSION))
  })
  it.each(["text", "forum", "thread", "dm"] as const)("requires complete current %s channel facts", type => {
    const value = { ...communityResourceChannelFixture, type }
    expect(CommunityChannelResourceSchema.parse(value)).toEqual(value)
    for (const key of Object.keys(value)) {
      const partial: Record<string, unknown> = { ...value }; delete partial[key]
      expect(CommunityChannelResourceSchema.safeParse(partial).success).toBe(false)
    }
    for (const fields of [{ archived: 0 }, { topic: null }, { messageCount: -1 }, { position: Infinity }, { resourceComplete: true }]) {
      expect(CommunityChannelResourceSchema.safeParse({ ...value, ...fields }).success).toBe(false)
    }
  })
  it("rejects incomplete committed messages and old attachment formats", () => {
    const value = communityResourceMessageFixture.message
    for (const key of ["id", "channelId", "seq", "authorId", "createdAt", "content", "replyToId", "clientNonce", "attachments"]) {
      const partial: Record<string, unknown> = { ...value }; delete partial[key]
      expect(CommunityMessageResourceSchema.safeParse(partial).success).toBe(false)
    }
    expect(CommunityMessageResourceSchema.safeParse({ ...value, attachments: [{ kind: "file", name: "file", url: "/file", size: "1 KB" }] }).success).toBe(false)
  })
})

describe("conversation entry resource", () => {
  const entry = () => ({
    contractVersion: BUSINESS_SCHEMA_VERSION,
    channelId: communityResourceChannelFixture.id,
    viewerId: "viewer", peer: null,
    channel: communityResourceChannelFixture,
    access: { channelId: communityResourceChannelFixture.id, canRead: true, canSend: true, canCreateDiscussion: false },
    readState: { channelId: communityResourceChannelFixture.id, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
    messages: [], profiles: [],
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
      contractVersion: BUSINESS_SCHEMA_VERSION, channelId: channel.id, channel, threads: [child],
      included: { messages: [opener, message], tags: [{ messageId: "opener", tag: "tag" }], participantCounts: [{ channelId: child.id, count: 1 }],
        profiles: [...communityResourceMessageFixture.profiles, { id: "peer", name: "Peer", discriminator: "1234", avatar: null, avatarVersion: 0 }],
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
    expect(communityReadSchemas().messages.safeParse(value).success).toBe(false)
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


describe("full current resource facts", () => {
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


describe("nested current resource facts", () => {
  it("preserves actual nullable thread fields and requires participant facts", () => {
    const thread = { id: "thread", name: null, messageCount: 0, lastReplyAt: null, participants: [{ id: "peer", name: "Peer", avatar: null, avatarVersion: 4 }] }
    const message = { ...communityResourceMessageFixture.message, thread }
    expect(CommunityMessageResourceSchema.parse(message).thread).toEqual(thread)
    for (const field of ["name", "avatar", "avatarVersion"]) {
      const participant: Record<string, unknown> = { ...thread.participants[0] }; delete participant[field]
      expect(CommunityMessageResourceSchema.safeParse({ ...message, thread: { ...thread, participants: [participant] } }).success).toBe(false)
    }
  })
})


describe("complete message author dependency graphs", () => {
  const author = { id: "author", name: "Former", discriminator: "0042", avatar: null, avatarVersion: 0 }
  const replyAuthor = { ...author, id: "reply-author", name: "Reply author" }
  const message = { ...communityResourceMessageFixture.message, authorId: author.id, replyToId: "prior", replyTo: { id: "prior", authorId: replyAuthor.id, authorName: replyAuthor.name, text: "Prior" } }
  it("requires every live author and preserves real nullable profile fields", () => {
    const graph = { messages: [message], profiles: [author, replyAuthor] }
    expect(CommunityMessageResourcesSchema.parse(graph)).toEqual(graph)
    expect(communityMessageProfileIds(graph.messages)).toEqual([author.id, replyAuthor.id])
    expect(CommunityMessageResourcesSchema.parse({ messages: [], profiles: [] })).toEqual({ messages: [], profiles: [] })
  })
  it.each(["main", "reply", "duplicate", "null-discriminator", "missing-avatar", "live-reply-id"])("rejects incomplete or ambiguous author dependencies (%s)", defect => {
    const profiles = defect === "main" ? [replyAuthor] : defect === "reply" ? [author] : defect === "duplicate" ? [author, replyAuthor, author] : [author, replyAuthor]
    const graph: { messages: unknown[]; profiles: unknown[] } = { messages: [message], profiles }
    if (defect === "null-discriminator") graph.profiles = [{ ...author, discriminator: null }, replyAuthor]
    if (defect === "missing-avatar") { const { avatar: _avatar, ...partial } = author; graph.profiles = [partial, replyAuthor] }
    if (defect === "live-reply-id") { const { authorId: _authorId, ...partial } = message.replyTo; graph.messages = [{ ...message, replyTo: partial }] }
    expect(CommunityMessageResourcesSchema.safeParse(graph).success).toBe(false)
  })
  it("keeps an explicit deleted reply sentinel separate from a missing live person", () => {
    const sentinel = { ...message, replyTo: { id: "prior", authorName: "Deleted user", text: "", deleted: true } }
    expect(CommunityMessageResourcesSchema.parse({ messages: [sentinel], profiles: [author] }).messages[0].replyTo).toEqual(sentinel.replyTo)
    expect(communityMessageProfileIds([sentinel])).toEqual([author.id])
  })
})
