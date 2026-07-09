import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessageInScope = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockCreateAttachment = vi.fn()
const mockListChildChannels = vi.fn()
const mockListMessages = vi.fn()
const mockListMessagesAround = vi.fn()
const mockListMessagesSince = vi.fn()
const mockGetLatestMessageSeq = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()
const mockGetUserInternal = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockBroadcastToUser = vi.fn()
const mockCheckMessageRateLimit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckMessageRateLimit(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessageInScope: (...a: unknown[]) => mockGetMessageInScope(...a),
        getMessagesByIdsInScope: (...a: unknown[]) => mockGetMessagesByIdsInScope(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
        listMessagesAround: (...a: unknown[]) => mockListMessagesAround(...a),
        listMessagesSince: (...a: unknown[]) => mockListMessagesSince(...a),
        getLatestMessageSeq: (...a: unknown[]) => mockGetLatestMessageSeq(...a),
      },
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityMention: {
        createMentions: (...a: unknown[]) => mockCreateMentions(...a),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number, headers?: Record<string, string>) =>
      NextResponse.json({ error: message }, { status, ...(headers ? { headers } : {}) }),
  }
})

import { POST, GET } from "./route"
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE, WS_EVENTS } from "@alook/shared"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function getReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/messages", { method: "GET" })
}

const ctx = { params: { id: "c1" } } as any

describe("POST /api/community/channels/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockCreateMessage.mockResolvedValue({ id: "m1" })
    // Human author by default — `createCommunityMessage`'s bot-authored audit
    // (plan §10) only fires when `isBot === true`, which none of these tests exercise.
    mockGetUserInternal.mockResolvedValue({ isBot: false, deletedAt: null })
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      authorEmail: "u1@t.com",
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
    mockListMembers.mockResolvedValue([])
    mockListMemberUserIds.mockResolvedValue([])
    mockGetMessagesByIdsInScope.mockResolvedValue([])
    mockCreateMentions.mockResolvedValue(undefined)
    mockCreateAttachment.mockImplementation(async (_db: unknown, input: any) => ({
      id: "a1",
      ...input,
    }))
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: true })
  })

  it("returns 429 with Retry-After when the sender is rate limited", async () => {
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 7 })

    const res = await POST(postReq({ content: "hello" }), ctx)

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("7")
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("checks the rate limit for the sender's userId, scoped after channel-membership auth", async () => {
    const res = await POST(postReq({ content: "hello" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCheckMessageRateLimit).toHaveBeenCalledWith(expect.anything(), "community:msgSend", "u1")
    // Membership check must run before rate limiting (auth first).
    expect(mockGetChannelForMember).toHaveBeenCalled()
  })

  it("rejects content longer than MAX_MESSAGE_CONTENT_LENGTH with 400", async () => {
    const tooLong = "a".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
    const res = await POST(postReq({ content: tooLong }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("rejects more than MAX_ATTACHMENTS_PER_MESSAGE attachments with 400", async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({
      url: `r2://x/${i}`,
      filename: `f${i}.png`,
      contentType: "image/png",
      size: 1,
    }))
    const res = await POST(postReq({ content: "ok", attachments }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("fans out @everyone mention to every non-author member", async () => {
    // Content has no "@" — everyone/here broadcast should go through the
    // userId-only projection, not the name-projected listMembers path.
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

    const res = await POST(postReq({ content: "hey team", mentionType: "everyone" }), ctx)

    expect(res.status).toBe(201)
    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledTimes(1)
    const [, payload] = mockCreateMentions.mock.calls[0]
    expect(payload.kind).toBe("mention")
    expect(payload.userIds.sort()).toEqual(["u2", "u3"])

    const broadcastTargets = mockBroadcastToUser.mock.calls.map((c) => c[0]).sort()
    expect(broadcastTargets).toEqual(["u2", "u3"])
  })

  it("resolves @Bob candidate via listMembers (name-projected) when content includes '@'", async () => {
    // Content contains "@" — the single fetch must be listMembers (needs
    // userName), covering both broadcast + candidate branches. listMemberUserIds
    // must not fire so we don't double-query.
    mockListMembers.mockResolvedValue([
      { userId: "u1", userName: "Alice" },
      { userId: "u2", userName: "Bob" },
      { userId: "u3", userName: "Carol" },
    ])
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      authorEmail: "u1@t.com",
      content: "hi @Bob",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })

    const res = await POST(postReq({ content: "hi @Bob" }), ctx)

    expect(res.status).toBe(201)
    expect(mockListMembers).toHaveBeenCalledTimes(1)
    expect(mockListMemberUserIds).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledTimes(1)
    const [, payload] = mockCreateMentions.mock.calls[0]
    expect(payload.kind).toBe("mention")
    expect(payload.userIds).toEqual(["u2"])
  })

  it("does not query members for a plain channel post with no '@' and no everyone/here", async () => {
    // No "@" in content and no broadcast mentionType — neither member query
    // should fire. This is the short-circuit branch of the split in
    // message-handler.ts.
    const res = await POST(postReq({ content: "just a note" }), ctx)
    expect(res.status).toBe(201)
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockListMemberUserIds).not.toHaveBeenCalled()
  })

  it("fans CHILD_CHANNEL_UPDATE to the parent when POSTing to a thread channel", async () => {
    // A channel row with a non-null parentChannelId is a thread. Server-side
    // detection replaced the client-side branch: the client always POSTs to
    // /channels/{id}, and this route must recognize the thread and fan out
    // CHILD_CHANNEL_UPDATE so the parent's thread indicator ticks. Before the
    // consolidation, this fan-out lived only in /threads/{id}/messages, so a
    // fast user could beat the client's meta fetch and silently skip it.
    mockGetChannelForMember.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      parentChannelId: "c-parent",
    })
    mockGetChannel.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      parentChannelId: "c-parent",
      messageCount: 7,
      lastMessageAt: "2026-06-30T01:00:00.000Z",
    })

    const res = await POST(postReq({ content: "in-thread" }), ctx)
    expect(res.status).toBe(201)

    const childUpdateCall = mockFanOutToChannel.mock.calls.find(
      (c) => c[1]?.type === WS_EVENTS.CHILD_CHANNEL_UPDATE,
    )
    expect(childUpdateCall).toBeTruthy()
    expect(childUpdateCall![0]).toBe("c-parent")
    expect(childUpdateCall![1].parentChannelId).toBe("c-parent")
    expect(childUpdateCall![1].channelId).toBe("c1")
    expect(childUpdateCall![1].changes.messageCount).toBe(7)
  })

  it("does NOT fan CHILD_CHANNEL_UPDATE for a top-level channel (regression)", async () => {
    // Regression: parentChannelId=null must stay the plain-channel path. Only
    // MESSAGE_CREATE should fan out; CHILD_CHANNEL_UPDATE would misdirect the
    // parent-indicator UI for a channel with no parent.
    mockGetChannelForMember.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      parentChannelId: null,
    })

    const res = await POST(postReq({ content: "top-level" }), ctx)
    expect(res.status).toBe(201)

    const childUpdateCall = mockFanOutToChannel.mock.calls.find(
      (c) => c[1]?.type === WS_EVENTS.CHILD_CHANNEL_UPDATE,
    )
    expect(childUpdateCall).toBeUndefined()
    // getChannel is only invoked in the thread branch to read messageCount /
    // lastMessageAt for the CHILD_CHANNEL_UPDATE payload — must not fire here.
    expect(mockGetChannel).not.toHaveBeenCalled()
  })
})

describe("GET /api/community/channels/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockListChildChannels.mockResolvedValue([])
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    // Every route branch calls `getLatestMessageSeq` — default to a small
    // sentinel so each test doesn't have to wire it individually.
    mockGetLatestMessageSeq.mockResolvedValue(0)
  })

  it("resolves reply previews via one scoped getMessagesByIdsInScope call (never per-item getMessage)", async () => {
    // 5-message page. 3 have replyToId set:
    //   m-a → target r-in-scope (same channel) → resolves.
    //   m-b → target r-out-of-scope (a different channel) → the scoped query
    //         never returns it (filtered in SQL, not application code) → deleted.
    //   m-c → target r-missing → deleted.
    //   m-d → replies to r-in-scope again → resolves.
    //   m-e → no reply.
    mockListMessages.mockResolvedValue([
      { id: "m-a", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hey", type: "default", mentionType: null, replyToId: "r-in-scope", channelId: "c1", embeds: null, createdAt: "t1" },
      { id: "m-b", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "leak?", type: "default", mentionType: null, replyToId: "r-out-of-scope", channelId: "c1", embeds: null, createdAt: "t2" },
      { id: "m-c", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "gone", type: "default", mentionType: null, replyToId: "r-missing", channelId: "c1", embeds: null, createdAt: "t3" },
      { id: "m-d", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "again", type: "default", mentionType: null, replyToId: "r-in-scope", channelId: "c1", embeds: null, createdAt: "t4" },
      { id: "m-e", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "no reply", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "t5" },
    ])
    // The (mocked) scoped query only ever returns in-scope rows — "r-out-of-scope"
    // and "r-missing" are absent, simulating the real WHERE-clause scoping.
    mockGetMessagesByIdsInScope.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", channelId: "c1", dmConversationId: null },
    ])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; replyTo?: { id: string; authorName: string; text: string; deleted?: boolean } }> }
    const byId = new Map(body.messages.map((m) => [m.id, m]))

    expect(byId.get("m-a")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-b")?.replyTo).toEqual({ id: "r-out-of-scope", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-c")?.replyTo).toEqual({ id: "r-missing", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-d")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-e")?.replyTo).toBeUndefined()

    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockGetMessage).not.toHaveBeenCalled()
    const [, , scope] = mockGetMessagesByIdsInScope.mock.calls[0]
    expect(scope).toEqual({ channelId: "c1" })
  })

  it("returns author.name verbatim — no 'Unknown' sentinel, no email leak", async () => {
    // Post-migration 0050 the shared query returns user.name as a non-empty
    // string. The route must drop the pre-migration cascade
    // (`authorName ?? authorEmail ?? "Unknown"`) and pass the name through.
    mockListMessages.mockResolvedValue([
      {
        id: "m-1",
        authorId: "u1",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        authorImage: null,
        content: "hey",
        type: "default",
        mentionType: null,
        replyToId: null,
        channelId: "c1",
        embeds: null,
        createdAt: "t1",
      },
    ])
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: Array<{ authorName: string; authorAvatar: string }>
    }
    expect(body.messages[0]?.authorName).toBe("Alice")
    expect(body.messages[0]?.authorName).not.toBe("Unknown")
    expect(body.messages[0]?.authorName).not.toContain("@")
    expect(body.messages[0]?.authorAvatar).toBe("A")
  })

  it("runs attachment, reaction, reply-target, child-channel, and latest-seq fetches in parallel", async () => {
    // The 5 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. We prove concurrency by
    // observing the in-flight count of the mocked queries.
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hi", type: "default", mentionType: null, replyToId: "r-1", channelId: "c1", embeds: null, createdAt: "t1" },
    ])

    let inFlight = 0
    let maxInFlight = 0
    async function tracked<T>(value: T): Promise<T> {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      return value
    }
    mockListByMessageIds.mockImplementation(() => tracked([]))
    mockListReactionsByMessageIds.mockImplementation(() => tracked([]))
    mockGetMessagesByIdsInScope.mockImplementation(() => tracked([]))
    mockListChildChannels.mockImplementation(() => tracked([]))
    mockGetLatestMessageSeq.mockImplementation(() => tracked(0))

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)

    // All 5 fetches must have been kicked off before any resolves.
    expect(maxInFlight).toBe(5)
    expect(mockListByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockListReactionsByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockListChildChannels).toHaveBeenCalledTimes(1)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledTimes(1)
  })

  it("passes parsed embeds through to the response body verbatim", async () => {
    // listMessages already parses embeds at the query layer — the route just
    // forwards. Rows returning `undefined` render as absent embeds; rows with
    // a parsed array render as-is (no double-parse, no re-stringify).
    const parsed = [{ url: "https://x/y", title: "hi" }]
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "with embed", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: parsed, createdAt: "t1" },
      { id: "m-2", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "no embed", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: undefined, createdAt: "t2" },
    ])
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; embeds?: unknown }> }
    const byId = new Map(body.messages.map((m) => [m.id, m]))
    expect(byId.get("m-1")?.embeds).toEqual(parsed)
    expect(byId.get("m-2")?.embeds).toBeUndefined()
  })

  it("always includes latestSeq in the legacy-mode envelope", async () => {
    // The client (A2) reads latestSeq unconditionally — it must be present in
    // every mode's envelope, including the legacy path.
    mockListMessages.mockResolvedValue([])
    mockGetLatestMessageSeq.mockResolvedValue(17)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { latestSeq: number }
    expect(body.latestSeq).toBe(17)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledWith(expect.anything(), { channelId: "c1" })
  })

  describe("?anchor mode", () => {
    it("returns a centered window with the anchor row present, plus latestSeq + cursors", async () => {
      mockGetMessageInScope.mockResolvedValue({
        id: "m_anchor",
        createdAt: "2026-06-30T00:00:03.000Z",
      })
      mockListMessagesAround.mockResolvedValue({
        older: [
          { id: "m_o1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "o1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:02.000Z" },
        ],
        newer: [
          { id: "m_anchor", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "anchor", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:03.000Z" },
          { id: "m_n1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "n1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:04.000Z" },
        ],
        hasMoreOlder: true,
        hasMoreNewer: false,
      })
      mockGetLatestMessageSeq.mockResolvedValue(9)

      const url = "http://localhost/api/community/channels/c1/messages?anchor=m_anchor"
      const req = new NextRequest(url, { method: "GET" })
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        messages: Array<{ id: string }>
        hasMoreOlder: boolean
        hasMoreNewer: boolean
        olderCursor?: string
        newerCursor?: string
        latestSeq: number
      }
      // Order is chronological ASC: older-reversed then newer.
      expect(body.messages.map((m) => m.id)).toEqual(["m_o1", "m_anchor", "m_n1"])
      expect(body.hasMoreOlder).toBe(true)
      expect(body.hasMoreNewer).toBe(false)
      // olderCursor points at the oldest returned row; newerCursor only when hasMoreNewer.
      expect(body.olderCursor).toBe(`2026-06-30T00:00:02.000Z|m_o1`)
      expect(body.newerCursor).toBeUndefined()
      expect(body.latestSeq).toBe(9)
      // Scope-first resolve: anchor lookup passes the channel scope.
      expect(mockGetMessageInScope).toHaveBeenCalledWith(expect.anything(), "m_anchor", { channelId: "c1" })
    })

    it("returns 404 when the anchor is not visible in this channel", async () => {
      mockGetMessageInScope.mockResolvedValue(null)
      const req = new NextRequest("http://localhost/api/community/channels/c1/messages?anchor=m_missing", {
        method: "GET",
      })
      const res = await GET(req, ctx)
      expect(res.status).toBe(404)
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })
  })

  describe("?since mode", () => {
    it("returns rows strictly newer than the cursor with hasMoreNewer + newerCursor + latestSeq", async () => {
      mockListMessagesSince.mockResolvedValue([
        { id: "m_1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:01.000Z" },
        { id: "m_2", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "2", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:02.000Z" },
      ])
      mockGetLatestMessageSeq.mockResolvedValue(2)

      const req = new NextRequest(
        "http://localhost/api/community/channels/c1/messages?since=2026-06-30T00:00:00.000Z%7Cm_0",
        { method: "GET" },
      )
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        messages: Array<{ id: string }>
        hasMoreNewer: boolean
        newerCursor?: string
        latestSeq: number
      }
      expect(body.messages.map((m) => m.id)).toEqual(["m_1", "m_2"])
      expect(body.hasMoreNewer).toBe(false)
      expect(body.latestSeq).toBe(2)
      // Anchor-mode paths must not fire.
      expect(mockGetMessageInScope).not.toHaveBeenCalled()
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })
  })
})
