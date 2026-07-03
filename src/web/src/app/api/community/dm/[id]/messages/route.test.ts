import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetDM = vi.fn()
const mockIsBlocked = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockListMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateAttachment = vi.fn()

const mockFanOutToDM = vi.fn()
const mockBroadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

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
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
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
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
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
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
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

  it("resolves reply previews via one getMessagesByIds call (never per-item getMessage)", async () => {
    // 5-message page. 3 have replyToId set:
    //   m-a → target r-in-scope (same DM) → resolves.
    //   m-b → target r-out-of-scope (different DM) → filtered → deleted: true.
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
    mockGetMessagesByIds.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", dmConversationId: "d1", channelId: null },
      // r-out-of-scope belongs to a different DM — filter must drop it.
      { id: "r-out-of-scope", authorName: "Zed", content: "elsewhere", dmConversationId: "d-other", channelId: null },
      // r-missing intentionally not returned.
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

    // Single batched fetch — no per-item getMessage.
    expect(mockGetMessagesByIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessage).not.toHaveBeenCalled()
    const [, ids] = mockGetMessagesByIds.mock.calls[0]
    expect(ids.sort()).toEqual(["r-in-scope", "r-in-scope", "r-missing", "r-out-of-scope"].sort())
  })

  it("runs attachment, reaction, and reply-target fetches in parallel", async () => {
    // The 3 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. Prove it by observing
    // in-flight count — all 3 must be dispatched before any resolves.
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
    mockGetMessagesByIds.mockImplementation(() => tracked([]))

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)

    expect(maxInFlight).toBe(3)
    expect(mockListByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockListReactionsByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessagesByIds).toHaveBeenCalledTimes(1)
  })
})
