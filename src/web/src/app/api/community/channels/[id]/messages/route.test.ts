import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockCreateAttachment = vi.fn()
const mockListChildChannels = vi.fn()
const mockListMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockBroadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

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
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
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
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
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
    mockGetMessagesByIds.mockResolvedValue([])
    mockCreateMentions.mockResolvedValue(undefined)
    mockCreateAttachment.mockImplementation(async (_db: unknown, input: any) => ({
      id: "a1",
      ...input,
    }))
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
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
  })

  it("resolves reply previews via one getMessagesByIds call (never per-item getMessage)", async () => {
    // 5-message page. 3 have replyToId set:
    //   m-a → target r-in-scope (same channel) → resolves.
    //   m-b → target r-out-of-scope (different channel) → filtered → deleted.
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
    mockGetMessagesByIds.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", channelId: "c1", dmConversationId: null },
      { id: "r-out-of-scope", authorName: "Zed", content: "elsewhere", channelId: "c-other", dmConversationId: null },
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

    expect(mockGetMessagesByIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessage).not.toHaveBeenCalled()
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

  it("runs attachment, reaction, reply-target, and child-channel fetches in parallel", async () => {
    // The 4 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. We prove concurrency by
    // observing the in-flight count of the mocked queries: if any two are
    // running at the same time, the max concurrency is >= 2.
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
    mockGetMessagesByIds.mockImplementation(() => tracked([]))
    mockListChildChannels.mockImplementation(() => tracked([]))

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)

    // All 4 fetches must have been kicked off before any resolves — proving
    // Promise.all, not sequential await.
    expect(maxInFlight).toBe(4)
    expect(mockListByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockListReactionsByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessagesByIds).toHaveBeenCalledTimes(1)
    expect(mockListChildChannels).toHaveBeenCalledTimes(1)
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
})
