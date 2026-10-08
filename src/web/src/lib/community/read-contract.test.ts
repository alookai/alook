import { describe, expect, it } from "vitest"
import { COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { writeCommunityChannelRead, writeCommunityMessagesRead, writeCommunityReadState } from "./read-contract"
import { decodeCommunityReadResponse } from "./read-response"
import { parseCommunityMessageWindow } from "./messages"
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
    expect(decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body)).toMatchObject({ olderCursor: "cursor", hasMoreOlder: true, surfaceReceipt: { surfaceKind } })
    const state = writeCommunityReadState(request("2"), "channel", { lastReadAt: null, lastReadMessageId: null, lastReadSeq: 0 })
    expect(decodeCommunityReadResponse("/api/community/channels/channel/read-state", "GET", state, await state.json())).toEqual({ channelId: "channel", lastReadAt: null, lastReadMessageId: null, lastReadSeq: 0 })
  })
  it("gives DM and channel transports a single target identity", () => {
    expect(communityKeys.dmMessages("channel")).toEqual(communityKeys.channelMessages("channel"))
    expect(communityKeys.dmReadStateSnapshot("channel")).toEqual(communityKeys.channelReadStateSnapshot("channel"))
    expect(communityKeys.channelMeta(null, "channel")).toEqual(communityKeys.channelMeta("server", "channel"))
    expect(communityKeys.channelMembers("channel", "access")).not.toEqual(communityKeys.channelMembers("channel", "notify"))
  })
  it("normalizes legacy message bytes with the same core resource validator", () => {
    const message = { id: "message", authorId: "author", seq: 1, createdAt: "2026-10-07T12:00:00Z", type: "chat", content: "hello" }
    const decoded = decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [message], latestSeq: 1 })
    expect(decoded).toMatchObject({ latestSeq: 1, messages: [{ ...message, channelId: "channel", replyToId: null, attachments: [] }] })
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [{ ...message, seq: undefined }] })).toThrow()
    expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", new Response(), { messages: [{ ...message, channelId: "foreign" }] })).toThrow("scope mismatch")
  })
  it("validates window exclusivity, cursors and limits", () => {
    expect(parseCommunityMessageWindow(new URLSearchParams("window=after&cursor=2026-10-07T12%3A00%3A00Z%7Cm1&limit=10"))).toMatchObject({ since: { id: "m1" }, pageSize: 10 })
    for (const input of ["window=before", "window=around&cursor=x&anchorMessageId=m1", "cursor=x", "cursor=a%7Cb%7Cc", "limit=1.5", "window=tail&since=x", "anchor=m1&cursor=x"]) expect(() => parseCommunityMessageWindow(new URLSearchParams(input))).toThrow()
  })
})
