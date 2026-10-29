import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, type CommunityConversationEntryRead } from "@alook/shared"
import { channelResourceFixture, messageResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { writeCommunityChannelRead, writeCommunityMessagesRead, writeCommunityConversationEntryRead } from "./read-contract"
import { decodeCommunityReadResponse } from "./read-response"
import { parseCommunityMessageWindow } from "./messages"
import { mapMessageForWs } from "./message-payload"
import { projectCommunityMessageCreate } from "./message-wire"
import { communityKeys } from "@/lib/query-keys"

const request = (version?: string) => new Request("https://alook.test/api/community/channels/channel", { headers: version ? { [COMMUNITY_CONTRACT_HEADER]: version } : {} })
const channel = channelResourceFixture({ id: "channel", type: "dm", serverId: null, name: null })

describe("common reading negotiation", () => {
  it("emits current metadata and requires exact response confirmation", async () => {
    const access = { canRead: true, canSend: false, canCreateDiscussion: false }
    const current = writeCommunityChannelRead(request(String(BUSINESS_SCHEMA_VERSION)), "channel", channel, access)
    expect(current.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    const body = await current.json()
    expect(decodeCommunityReadResponse("/api/community/channels/channel", "GET", current, body)).toEqual({ ...channel, accessDecision: { channelId: "channel", ...access } })
    expect(() => decodeCommunityReadResponse("/api/community/channels/other", "GET", current, body)).toThrow("scope mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel", "GET", new Response(), body)).toThrow("confirmation mismatch")
  })
  it.each(["channel", "forum", "thread", "dm"] as const)("uses the same message resource for %s", async (surfaceKind) => {
    const message = messageResourceFixture({ id: "m1", channelId: "channel", authorId: "user", content: "hello" })
    const response = writeCommunityMessagesRead(request(String(BUSINESS_SCHEMA_VERSION)), "channel", { messages: [message], profiles: [profileResourceFixture({ id: "user", name: "User" })], latestSeq: 1, hasMore: true, cursor: "cursor", surfaceReceipt: { channelId: "channel", surfaceKind } })
    const body = await response.json()
    expect(body.messages[0]).toMatchObject({ channelId: "channel", clientNonce: null, replyToId: null, attachments: [] })
    expect(body.messages[0]).not.toHaveProperty("resourceComplete")
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body)).toMatchObject({ olderCursor: "cursor", hasMoreOlder: true, surfaceReceipt: { surfaceKind } })
  })
  it("gives DM and channel transports a single target identity", () => {
    expect(communityKeys.dmMessages("channel")).toEqual(communityKeys.channelMessages("channel"))
    expect(communityKeys.channelMeta(null, "channel")).toEqual(communityKeys.channelMeta("server", "channel"))
    expect(communityKeys.channelMembers("channel", "access")).not.toEqual(communityKeys.channelMembers("channel", "notify"))
  })
  it("rejects old message bytes without creating missing resource facts", () => {
    const partial = { id: "message", authorId: "author", seq: 1, createdAt: "now", type: "chat", content: "hello" }
    const path = "/api/community/channels/channel/messages"
    expect(() => decodeCommunityReadResponse(path, "GET", new Response(), { messages: [partial] })).toThrow("confirmation mismatch")
    const response = new Response(null, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
    expect(() => decodeCommunityReadResponse(path, "GET", response, { contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", messages: [partial] })).toThrow()
  })
  it("validates window exclusivity, cursors and limits", () => {
    expect(parseCommunityMessageWindow(new URLSearchParams("window=after&cursor=2026-10-07T12%3A00%3A00Z%7Cm1&limit=10"))).toMatchObject({ since: { id: "m1" }, pageSize: 10 })
    for (const input of ["window=before", "window=around&cursor=x&anchorMessageId=m1", "cursor=x", "cursor=a%7Cb%7Cc", "limit=1.5", "window=tail&since=x", "anchor=m1&cursor=x"]) expect(() => parseCommunityMessageWindow(new URLSearchParams(input))).toThrow()
  })
})


describe("current resource ingress", () => {
  it.each(["channel", "forum", "thread", "dm"] as const)("converges HTTP and WS raw facts for %s", async (surfaceKind) => {
    const attachments = [{ id: "a2", name: "first", url: "/first", thumbnailUrl: null, contentType: null, sizeBytes: null, width: null, height: null }, { id: "a1", name: "second", url: "/second", thumbnailUrl: null, contentType: "image/png", sizeBytes: 1024, width: 40, height: 50 }]
    const row = { id: "full", seq: 2, authorId: "peer", authorName: "Peer", authorImage: null, authorAvatarVersion: 4, createdAt: "now", type: "chat", content: "body", clientNonce: "nonce", replyToId: null, mentionType: null, embeds: [null, { unsupported: true }] }
    const full = mapMessageForWs(row, { replyMap: new Map(), attachments: [], resourceAttachments: attachments, clientNonce: "nonce" }, BUSINESS_SCHEMA_VERSION, "channel")
    const response = writeCommunityMessagesRead(request(String(BUSINESS_SCHEMA_VERSION)), "channel", { messages: [full], profiles: [profileResourceFixture({ id: "peer", name: "Peer", avatarVersion: 4 })], latestSeq: 2, surfaceReceipt: { channelId: "channel", surfaceKind } })
    const body = await response.json()
    const http = decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body, BUSINESS_SCHEMA_VERSION) as { messages: unknown[] }
    const ws = projectCommunityMessageCreate(full, "channel", BUSINESS_SCHEMA_VERSION)
    expect(http.messages).toEqual([ws])
    expect(ws).toMatchObject({ authorAvatar: null, attachments, embeds: row.embeds, clientNonce: "nonce" })
    const missing = { ...body, messages: [{ ...full, attachments: undefined }] }
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, missing, BUSINESS_SCHEMA_VERSION)).toThrow()
    expect(() => projectCommunityMessageCreate({ ...full, channelId: "foreign" }, "channel", BUSINESS_SCHEMA_VERSION)).toThrow("scope mismatch")
  })
})

describe("current conversation entry ingress", () => {
  const entry = (): CommunityConversationEntryRead => ({
    contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", viewerId: "viewer", peer: { id: "peer", name: "Peer", discriminator: "0042", avatar: null, avatarVersion: 0 },
    channel: channel,
    access: { channelId: "channel", canRead: true, canSend: false, canCreateDiscussion: false },
    readState: { channelId: "channel", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
    readStateRevision: 0, selection: { reason: "tail", anchorMessageId: null },
    surfaceReceipt: { channelId: "channel", surfaceKind: "dm" }, messages: [], profiles: [],
    page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 },
  })

  it("decodes an explicit entry without changing the ordinary message contract", async () => {
    const value = entry()
    const response = writeCommunityConversationEntryRead(value)
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    const body = await response.json()
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, body, BUSINESS_SCHEMA_VERSION)).toEqual(value)
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body, BUSINESS_SCHEMA_VERSION)).toThrow()
    expect(() => decodeCommunityReadResponse("/api/community/channels/foreign/messages?entry=1", "GET", response, body, BUSINESS_SCHEMA_VERSION)).toThrow("scope mismatch")
  })

  it("rejects a legacy response, wrong contract or unsupported opt-in value", async () => {
    const value = entry()
    const response = writeCommunityConversationEntryRead(value)
    for (const [path, version] of [
      ["/api/community/channels/channel/messages?entry=1", 2],
      ["/api/community/channels/channel/messages?entry=0", 3],
      ["/api/community/channels/channel/messages?entry=", 3],
    ] as const) expect(() => decodeCommunityReadResponse(path, "GET", response, value, version)).toThrow("confirmation mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", new Response(), value, BUSINESS_SCHEMA_VERSION)).toThrow("confirmation mismatch")
  })

  it("qualifies complete message rows only after entry scope validation", () => {
    const value = entry()
    const message = { id: "m1", channelId: "channel", seq: 1, authorId: "peer", createdAt: "now", type: "chat", content: "body", clientNonce: null, replyToId: null, attachments: [] }
    const body = { ...value, messages: [message], profiles: [profileResourceFixture({ id: "peer", name: "Peer" })] }
    const response = new Response(null, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, body, BUSINESS_SCHEMA_VERSION)).toMatchObject({ messages: [{ ...message }] })
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, { ...body, messages: [{ ...message, channelId: "foreign" }] }, BUSINESS_SCHEMA_VERSION)).toThrow("scope mismatch")
  })
})
