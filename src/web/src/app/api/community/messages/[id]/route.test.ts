import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMessage = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetDM = vi.fn()
const mockIsBlocked = vi.fn()
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
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
      },
      communityAttachment: {
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
      },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
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

function req() {
  return new NextRequest("http://localhost/api/community/messages/m1", { method: "GET" })
}

describe("GET /api/community/messages/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
  })

  it("returns the hydrated payload for a channel message when caller is a server member", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockListByMessageIds.mockResolvedValue([
      { messageId: "m1", filename: "photo.png", url: "https://cdn/1", contentType: "image/png", size: 12345 },
    ])
    mockListReactionsByMessageIds.mockResolvedValue([
      { messageId: "m1", emoji: "👍", userId: "u1" },
    ])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("m1")
    expect(body.content).toBe("hello")
    expect(body.authorName).toBe("Alice")
    // Attachments came through the mapper (grouped shape).
    expect(body.attachments).toEqual([
      { kind: "image", name: "photo.png", url: "https://cdn/1" },
    ])
    // Reactions came through with `me: true` since userId matches.
    expect(body.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u1"] },
    ])
    // GET convention: no `type: "default"` on the wire (undefined for default).
    expect(body.type).toBeUndefined()
  })

  it("hydrates reply preview when replyToId is set + target is in the same channel", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "yes",
      type: "default",
      mentionType: null,
      replyToId: "m0",
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMessagesByIds.mockResolvedValue([
      { id: "m0", authorName: "Bob", content: "question?", channelId: "c1" },
    ])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    const body = await res.json()
    expect(body.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "question?" })
  })

  it("filters out reply preview when target is in a different channel (scope guard)", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "yes",
      type: "default",
      mentionType: null,
      replyToId: "m0",
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMessagesByIds.mockResolvedValue([
      { id: "m0", authorName: "Bob", content: "leaked?", channelId: "OTHER" },
    ])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    const body = await res.json()
    // Target filtered out — mapper returns the `deleted` sentinel.
    expect(body.replyTo).toEqual({ id: "m0", authorName: "Unknown", text: "", deleted: true })
  })

  it("returns 404 when the message doesn't exist", async () => {
    mockGetMessage.mockResolvedValue(null)
    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller isn't a member of the channel's server", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(403)
  })

  it("returns the payload for a DM message when caller participates", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "hi dm",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: null,
      dmConversationId: "dm-1",
    })
    mockGetDM.mockResolvedValue({
      id: "dm-1",
      user1Id: "u1",
      user2Id: "u2",
      lastMessageAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    mockIsBlocked.mockResolvedValue(false)

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("hi dm")
    // Never touched the channel-permission path.
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller doesn't participate in the DM", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-other",
      authorName: "Someone",
      authorImage: null,
      content: "secret",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: null,
      dmConversationId: "dm-1",
    })
    mockGetDM.mockResolvedValue({
      id: "dm-1",
      user1Id: "u-other",
      user2Id: "u-third",
      lastMessageAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    })

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(403)
  })

  it("returns 400 when the id param is missing", async () => {
    const res = await GET(req(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetMessage).not.toHaveBeenCalled()
  })
})
