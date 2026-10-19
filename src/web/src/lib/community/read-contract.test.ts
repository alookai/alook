import { describe, expect, it } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, normalizeCommunityChannelResource, type CommunityConversationEntryRead } from "@alook/shared"
import { writeCommunityChannelRead, writeCommunityMessagesRead, writeCommunityReadState, writeCommunityConversationEntryRead } from "./read-contract"
import { decodeCommunityReadResponse } from "./read-response"
import { parseCommunityMessageWindow } from "./messages"
import { mapMessageForWs } from "./message-payload"
import { projectCommunityMessageCreate } from "./message-wire"
import { communityKeys } from "@/lib/query-keys"

const request = (version?: string) => new Request("https://alook.test/api/community/channels/channel", { headers: version ? { [COMMUNITY_CONTRACT_HEADER]: version } : {} })
const channel = { id: "channel", type: "dm", serverId: null, name: null, archived: 0, createdAt: "2026-10-07T12:00:00Z" }

describe("common reading negotiation", () => {
  it("keeps legacy metadata and confirms the complete v2 read", async () => {
    const access = { canRead: true, canSend: false, canCreateDiscussion: false }
    const old = writeCommunityChannelRead(request(), "channel", channel, access)
    expect(await old.json()).toEqual(channel)
    const current = writeCommunityChannelRead(request("2"), "channel", channel, access)
    expect(current.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("2")
    const body = await current.json()
    const decoded = decodeCommunityReadResponse("/api/community/channels/channel", "GET", current, body)
    expect(decoded).toMatchObject({ id: "channel", accessDecision: { canRead: true, canSend: false } })
    expect(decoded).not.toHaveProperty("readContractVersion")
    expect(() => decodeCommunityReadResponse("/api/community/channels/other", "GET", current, body)).toThrow("scope mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel", "GET", new Response(), body)).toThrow("confirmation mismatch")
    expect(decodeCommunityReadResponse("/api/community/channels/channel", "GET", new Response(), { ...channel, readContractVersion: 2, accessDecision: access })).not.toHaveProperty("readContractVersion")
  })
  it.each(["channel", "forum", "thread", "dm"] as const)("uses the same message and read-state resource for %s", async (surfaceKind) => {
    const message = { id: "m1", seq: 1, authorId: "user", createdAt: "2026-10-07T12:00:00Z", content: "hello", type: "chat" }
    const response = writeCommunityMessagesRead(request("2"), "channel", { messages: [message], latestSeq: 1, hasMore: true, cursor: "cursor", surfaceReceipt: { channelId: "channel", surfaceKind } })
    const body = await response.json()
    expect(body.messages[0]).toMatchObject({ channelId: "channel", clientNonce: null, replyToId: null, attachments: [] })
    expect(body.messages[0]).not.toHaveProperty("resourceComplete")
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body)).toMatchObject({ olderCursor: "cursor", hasMoreOlder: true, surfaceReceipt: { surfaceKind } })
    const state = writeCommunityReadState(request("2"), "channel", { lastReadAt: null, lastReadMessageId: null, lastReadSeq: 0 })
    expect(decodeCommunityReadResponse("/api/community/channels/channel/read-state", "GET", state, await state.json())).toEqual({ channelId: "channel", lastReadAt: null, lastReadMessageId: null, lastReadSeq: 0 })
  })
  it("gives DM and channel transports a single target identity", () => {
    expect(communityKeys.dmMessages("channel")).toEqual(communityKeys.channelMessages("channel"))
    expect(communityKeys.channelMeta(null, "channel")).toEqual(communityKeys.channelMeta("server", "channel"))
    expect(communityKeys.channelMembers("channel", "access")).not.toEqual(communityKeys.channelMembers("channel", "notify"))
  })
  it("normalizes legacy message bytes with the same core resource validator", () => {
    const message = { id: "message", authorId: "author", seq: 1, createdAt: "2026-10-07T12:00:00Z", type: "chat", content: "hello" }
    const decoded = decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [message], latestSeq: 1 })
    expect(decoded).toMatchObject({ latestSeq: 1, messages: [{ ...message, channelId: "channel", resourceComplete: false }] })
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [{ ...message, seq: undefined }] })).toThrow()
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [{ ...message, channelId: "foreign" }] })).toThrow("scope mismatch")
  })
  it("validates window exclusivity, cursors and limits", () => {
    expect(parseCommunityMessageWindow(new URLSearchParams("window=after&cursor=2026-10-07T12%3A00%3A00Z%7Cm1&limit=10"))).toMatchObject({ since: { id: "m1" }, pageSize: 10 })
    for (const input of ["window=before", "window=around&cursor=x&anchorMessageId=m1", "cursor=x", "cursor=a%7Cb%7Cc", "limit=1.5", "window=tail&since=x", "anchor=m1&cursor=x"]) expect(() => parseCommunityMessageWindow(new URLSearchParams(input))).toThrow()
  })
})


describe("explicit resource 3 ingress", () => {
  it.each(["channel", "forum", "thread", "dm"] as const)("converges HTTP and WS raw facts for %s", async (surfaceKind) => {
    const attachments = [{ id: "a2", name: "first", url: "/first", thumbnailUrl: null, contentType: null, sizeBytes: null, width: null, height: null }, { id: "a1", name: "second", url: "/second", thumbnailUrl: null, contentType: "image/png", sizeBytes: 1024, width: 40, height: 50 }]
    const row = { id: "full", seq: 2, authorId: "peer", authorName: "Peer", authorImage: null, authorAvatarVersion: 4, createdAt: "now", type: "chat", content: "body", clientNonce: "nonce", replyToId: null, mentionType: null, embeds: [null, { unsupported: true }] }
    const full = mapMessageForWs(row, { replyMap: new Map(), attachments: [], resourceAttachments: attachments, clientNonce: "nonce" }, 3, "channel")
    const response = writeCommunityMessagesRead(request("3"), "channel", { messages: [full], latestSeq: 2, surfaceReceipt: { channelId: "channel", surfaceKind } })
    const body = await response.json()
    const http = decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body, 3) as { messages: unknown[] }
    const ws = projectCommunityMessageCreate(full, "channel", 3)
    expect(http.messages).toEqual([ws])
    expect(ws).toMatchObject({ resourceComplete: true, authorAvatar: null, attachments, embeds: row.embeds, clientNonce: "nonce" })
    const missing = { ...body, messages: [{ ...full, attachments: undefined }] }
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, missing, 3)).toThrow()
    expect(() => projectCommunityMessageCreate({ ...full, channelId: "foreign" }, "channel", 3)).toThrow("scope mismatch")
  })
})

describe("opt-in conversation entry ingress", () => {
  const entry = (): CommunityConversationEntryRead => ({
    contractVersion: 3, channelId: "channel", viewerId: "viewer", peer: { id: "peer", name: "Peer", discriminator: "0042", avatar: null, avatarVersion: 0 },
    channel: normalizeCommunityChannelResource(channel),
    access: { channelId: "channel", canRead: true, canSend: false, canCreateDiscussion: false },
    readState: { channelId: "channel", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
    readStateRevision: 0, selection: { reason: "tail", anchorMessageId: null },
    surfaceReceipt: { channelId: "channel", surfaceKind: "dm" }, messages: [],
    page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 },
  })

  it("decodes an explicit entry without changing the ordinary message contract", async () => {
    const value = entry()
    const response = writeCommunityConversationEntryRead(value)
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("3")
    const body = await response.json()
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, body, 3)).toEqual(value)
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body, 3)).toThrow()
    expect(() => decodeCommunityReadResponse("/api/community/channels/foreign/messages?entry=1", "GET", response, body, 3)).toThrow("scope mismatch")
  })

  it("rejects a legacy response, wrong contract or unsupported opt-in value", async () => {
    const value = entry()
    const response = writeCommunityConversationEntryRead(value)
    for (const [path, version] of [
      ["/api/community/channels/channel/messages?entry=1", 2],
      ["/api/community/channels/channel/messages?entry=0", 3],
      ["/api/community/channels/channel/messages?entry=", 3],
    ] as const) expect(() => decodeCommunityReadResponse(path, "GET", response, value, version)).toThrow("confirmation mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", new Response(), value, 3)).toThrow("confirmation mismatch")
  })

  it("qualifies complete message rows only after entry scope validation", () => {
    const value = entry()
    const message = { id: "m1", channelId: "channel", seq: 1, authorId: "peer", createdAt: "now", type: "chat", content: "body", clientNonce: null, replyToId: null, attachments: [] }
    const body = { ...value, messages: [message] }
    const response = new Response(null, { headers: { [COMMUNITY_CONTRACT_HEADER]: "3" } })
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, body, 3)).toMatchObject({ messages: [{ ...message, resourceComplete: true }] })
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1", "GET", response, { ...body, messages: [{ ...message, channelId: "foreign" }] }, 3)).toThrow("scope mismatch")
  })
})
