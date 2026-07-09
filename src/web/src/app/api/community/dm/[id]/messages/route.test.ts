import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetDM = vi.fn()
const mockIsBlocked = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessageInScope = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockListMessages = vi.fn()
const mockListMessagesAround = vi.fn()
const mockListMessagesSince = vi.fn()
const mockGetLatestMessageSeq = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateAttachment = vi.fn()
const mockGetUserInternal = vi.fn()

const mockFanOutToDM = vi.fn()
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
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
      },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
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
        createMentions: vi.fn(),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) =>
          mockListReactionsByMessageIds(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
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

import { GET, POST } from "./route"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/dm/d1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function getReq() {
  return new NextRequest("http://localhost/api/community/dm/d1/messages", {
    method: "GET",
  })
}

const ctx = { params: { id: "d1" } } as any

describe("POST /api/community/dm/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDM.mockResolvedValue({
      id: "d1",
      user1Id: "u1",
      user2Id: "u2",
      lastMessageAt: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
    // Human author by default — `createCommunityMessage`'s bot-authored audit
    // (plan §10) only fires when `isBot === true`, which none of these tests exercise.
    mockGetUserInternal.mockResolvedValue({ isBot: false, deletedAt: null })
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: true })
  })

  it("returns 429 with Retry-After when the sender is rate limited", async () => {
    mockIsBlocked.mockResolvedValue(false)
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 4 })

    const res = await POST(postReq({ content: "hi" }), ctx)

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("4")
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(mockFanOutToDM).not.toHaveBeenCalled()
  })

  it("returns 403 when the DM counterpart is blocked", async () => {
    mockIsBlocked.mockResolvedValue(true)

    const res = await POST(postReq({ content: "hi" }), ctx)

    expect(res.status).toBe(403)
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(mockFanOutToDM).not.toHaveBeenCalled()
  })

  it("does not query members for a DM post (target.kind === 'dm')", async () => {
    // DMs have no member roster and no @-anyone semantics — neither
    // listMembers nor listMemberUserIds should ever fire.
    mockIsBlocked.mockResolvedValue(false)
    mockCreateMessage.mockResolvedValue({ id: "m1" })
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
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockListMemberUserIds).not.toHaveBeenCalled()
  })
})

describe("GET /api/community/dm/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDM.mockResolvedValue({
      id: "d1",
      user1Id: "u1",
      user2Id: "u2",
      lastMessageAt: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
    // Every route branch calls `getLatestMessageSeq` — default to 0 so tests
    // don't have to wire it individually.
    mockGetLatestMessageSeq.mockResolvedValue(0)
  })

  it("returns 403 and never reads messages when the counterpart is blocked", async () => {
    // A blocked relationship must hide historical DM messages — the listMessages
    // query should never run for the blocked party. This is a security contract,
    // not just a UX nicety; lock it in.
    mockIsBlocked.mockResolvedValue(true)

    const res = await GET(getReq(), ctx)

    expect(res.status).toBe(403)
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  it("resolves reply previews via one scoped getMessagesByIdsInScope call (never per-item getMessage)", async () => {
    // 5-message page. 3 have replyToId set:
    //   m-a → target r-in-scope (same DM) → resolves.
    //   m-b → target r-out-of-scope (a different DM) → the scoped query never
    //         returns it (it's filtered in SQL, not in application code) → deleted: true.
    //   m-c → target r-missing → deleted: true.
    //   m-d → replies to r-in-scope again → resolves.
    //   m-e → no reply.
    mockIsBlocked.mockResolvedValue(false)
    mockListMessages.mockResolvedValue([
      { id: "m-a", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hey", type: "default", mentionType: null, replyToId: "r-in-scope", dmConversationId: "d1", embeds: null, createdAt: "t1" },
      { id: "m-b", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "leak?", type: "default", mentionType: null, replyToId: "r-out-of-scope", dmConversationId: "d1", embeds: null, createdAt: "t2" },
      { id: "m-c", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "gone", type: "default", mentionType: null, replyToId: "r-missing", dmConversationId: "d1", embeds: null, createdAt: "t3" },
      { id: "m-d", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "again", type: "default", mentionType: null, replyToId: "r-in-scope", dmConversationId: "d1", embeds: null, createdAt: "t4" },
      { id: "m-e", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "no reply", type: "default", mentionType: null, replyToId: null, dmConversationId: "d1", embeds: null, createdAt: "t5" },
    ])
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    // The (mocked) scoped query only ever returns in-scope rows — "r-out-of-scope"
    // and "r-missing" are absent, simulating the real WHERE-clause scoping.
    mockGetMessagesByIdsInScope.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", dmConversationId: "d1", channelId: null },
    ])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; replyTo?: { id: string; authorName: string; text: string; deleted?: boolean } }> }
    // route reverses the messages array before returning.
    const byId = new Map(body.messages.map((m) => [m.id, m]))

    expect(byId.get("m-a")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-b")?.replyTo).toEqual({ id: "r-out-of-scope", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-c")?.replyTo).toEqual({ id: "r-missing", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-d")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-e")?.replyTo).toBeUndefined()

    // Single batched, scoped fetch — no per-item getMessage.
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockGetMessage).not.toHaveBeenCalled()
    const [, ids, scope] = mockGetMessagesByIdsInScope.mock.calls[0]
    expect(ids.sort()).toEqual(["r-in-scope", "r-in-scope", "r-missing", "r-out-of-scope"].sort())
    expect(scope).toEqual({ dmConversationId: "d1" })
  })

  it("runs attachment, reaction, reply-target, and latest-seq fetches in parallel", async () => {
    // The 4 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. Prove it by observing
    // in-flight count — all 4 must be dispatched before any resolves.
    mockIsBlocked.mockResolvedValue(false)
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hi", type: "default", mentionType: null, replyToId: "r-1", dmConversationId: "d1", embeds: null, createdAt: "t1" },
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
    mockGetLatestMessageSeq.mockImplementation(() => tracked(0))

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)

    expect(maxInFlight).toBe(4)
    expect(mockListByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockListReactionsByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledTimes(1)
  })

  it("always includes latestSeq in the legacy-mode envelope", async () => {
    mockIsBlocked.mockResolvedValue(false)
    mockListMessages.mockResolvedValue([])
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    mockGetLatestMessageSeq.mockResolvedValue(23)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { latestSeq: number }
    expect(body.latestSeq).toBe(23)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledWith(expect.anything(), { dmConversationId: "d1" })
  })

  describe("?anchor mode", () => {
    it("returns a centered window with the anchor row present, plus latestSeq + cursors", async () => {
      mockIsBlocked.mockResolvedValue(false)
      mockGetMessageInScope.mockResolvedValue({
        id: "m_anchor",
        createdAt: "2026-06-30T00:00:03.000Z",
      })
      mockListMessagesAround.mockResolvedValue({
        older: [
          { id: "m_o1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "o1", type: "default", mentionType: null, replyToId: null, dmConversationId: "d1", embeds: null, createdAt: "2026-06-30T00:00:02.000Z" },
        ],
        newer: [
          { id: "m_anchor", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "anchor", type: "default", mentionType: null, replyToId: null, dmConversationId: "d1", embeds: null, createdAt: "2026-06-30T00:00:03.000Z" },
          { id: "m_n1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "n1", type: "default", mentionType: null, replyToId: null, dmConversationId: "d1", embeds: null, createdAt: "2026-06-30T00:00:04.000Z" },
        ],
        hasMoreOlder: false,
        hasMoreNewer: true,
      })
      mockListByMessageIds.mockResolvedValue([])
      mockListReactionsByMessageIds.mockResolvedValue([])
      mockGetLatestMessageSeq.mockResolvedValue(11)

      const req = new NextRequest("http://localhost/api/community/dm/d1/messages?anchor=m_anchor", {
        method: "GET",
      })
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
      expect(body.messages.map((m) => m.id)).toEqual(["m_o1", "m_anchor", "m_n1"])
      expect(body.hasMoreOlder).toBe(false)
      expect(body.hasMoreNewer).toBe(true)
      expect(body.olderCursor).toBeUndefined()
      expect(body.newerCursor).toBe(`2026-06-30T00:00:04.000Z|m_n1`)
      expect(body.latestSeq).toBe(11)
      // Scope-first resolve: anchor lookup passes the DM scope.
      expect(mockGetMessageInScope).toHaveBeenCalledWith(expect.anything(), "m_anchor", { dmConversationId: "d1" })
    })

    it("returns 404 when the anchor is not visible in this DM", async () => {
      mockIsBlocked.mockResolvedValue(false)
      mockGetMessageInScope.mockResolvedValue(null)
      const req = new NextRequest("http://localhost/api/community/dm/d1/messages?anchor=m_missing", {
        method: "GET",
      })
      const res = await GET(req, ctx)
      expect(res.status).toBe(404)
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })
  })

  describe("?since mode", () => {
    it("returns rows strictly newer than the cursor with hasMoreNewer + newerCursor + latestSeq", async () => {
      mockIsBlocked.mockResolvedValue(false)
      mockListMessagesSince.mockResolvedValue([
        { id: "m_1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "1", type: "default", mentionType: null, replyToId: null, dmConversationId: "d1", embeds: null, createdAt: "2026-06-30T00:00:01.000Z" },
      ])
      mockListByMessageIds.mockResolvedValue([])
      mockListReactionsByMessageIds.mockResolvedValue([])
      mockGetLatestMessageSeq.mockResolvedValue(1)

      const req = new NextRequest(
        "http://localhost/api/community/dm/d1/messages?since=2026-06-30T00:00:00.000Z%7Cm_0",
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
      expect(body.messages.map((m) => m.id)).toEqual(["m_1"])
      expect(body.hasMoreNewer).toBe(false)
      expect(body.latestSeq).toBe(1)
      expect(mockGetMessageInScope).not.toHaveBeenCalled()
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })
  })
})
