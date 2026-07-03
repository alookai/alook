import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockListMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityMessage: {
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      communityAttachment: {
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
    },
  }
})

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

import { GET } from "./route"

function getReq() {
  return new NextRequest("http://localhost/api/community/threads/t1/messages", {
    method: "GET",
  })
}

const ctx = { params: { id: "t1" } } as any

describe("GET /api/community/threads/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({
      id: "t1",
      serverId: "s1",
      parentChannelId: "c-parent",
    })
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
  })

  it("runs attachment, reaction, and reply-target fetches in parallel", async () => {
    // The 3 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. Prove it by observing
    // in-flight count — all 3 must be dispatched before any resolves.
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hi", type: "default", mentionType: null, replyToId: "r-1", channelId: "t1", embeds: null, createdAt: "t1" },
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

  it("preserves response shape: reply preview scoped to this channel", async () => {
    // Response shape sanity: reply target in-scope resolves; out-of-scope is
    // filtered and marked deleted. Same contract as the pre-Promise.all code.
    mockListMessages.mockResolvedValue([
      { id: "m-a", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hi", type: "default", mentionType: null, replyToId: "r-in-scope", channelId: "t1", embeds: null, createdAt: "t1" },
      { id: "m-b", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "leak?", type: "default", mentionType: null, replyToId: "r-out-of-scope", channelId: "t1", embeds: null, createdAt: "t2" },
    ])
    mockGetMessagesByIds.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", channelId: "t1", dmConversationId: null },
      { id: "r-out-of-scope", authorName: "Zed", content: "elsewhere", channelId: "c-other", dmConversationId: null },
    ])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; replyTo?: { id: string; authorName: string; text: string; deleted?: boolean } }> }
    const byId = new Map(body.messages.map((m) => [m.id, m]))

    expect(byId.get("m-a")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-b")?.replyTo).toEqual({ id: "r-out-of-scope", authorName: "Unknown", text: "", deleted: true })
  })
})
