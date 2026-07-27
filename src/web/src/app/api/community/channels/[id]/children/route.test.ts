import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockListChildChannels = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockGetFirstMessageByChannelIds = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockListParticipantsForChannels = vi.fn(async () => [] as unknown[])

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
      },
      communityMessage: {
        getFirstMessageByChannelIds: (...a: unknown[]) => mockGetFirstMessageByChannelIds(...a),
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
      },
      communityThread: {
        listParticipantsForChannels: (...a: unknown[]) => mockListParticipantsForChannels(...a),
      },
      user: { getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a) },
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

const ctx = { params: { id: "ch1" } } as any
function req(query = "") {
  return new NextRequest(`http://localhost/api/community/channels/ch1/children${query}`)
}

describe("GET /children — type param validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, creatorId: "u1", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: true,
    })
    mockListChildChannels.mockResolvedValue([])
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
    mockGetUsersByIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
  })

  it("400 when type is missing", async () => {
    const res = await GET(req(), ctx)
    expect(res.status).toBe(400)
  })

  it("400 when type is invalid", async () => {
    const res = await GET(req("?type=bogus"), ctx)
    expect(res.status).toBe(400)
  })

  it("403 when the caller can't access the channel", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await GET(req("?type=post"), ctx)
    expect(res.status).toBe(403)
  })
})

describe("GET /children?type=post", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, creatorId: "u1", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: true,
    })
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
    mockGetUsersByIds.mockResolvedValue([])
  })

  it("returns { children } with messageCount excluding the opener", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "First", type: "post", messageCount: 3, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])

    const res = await GET(req("?type=post"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.children).toHaveLength(1)
    expect(body.children[0].authorId).toBe("u_alice")
    // opener excluded: 3 - 1
    expect(body.children[0].messageCount).toBe(2)
    // hardcoded archived:false
    expect(mockListChildChannels).toHaveBeenCalledWith(expect.anything(), "ch1", { archived: false, type: "post" })
  })

  it("filters by ?tag=", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "p1", name: "Tagged", type: "post", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_a", tags: ["alpha"] },
      { id: "p2", name: "Other", type: "post", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_a", tags: ["beta"] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_a", name: "A", image: null }])
    const res = await GET(req("?type=post&tag=alpha"), ctx)
    const body = await res.json()
    expect(body.children.map((c: { id: string }) => c.id)).toEqual(["p1"])
  })

  it("400 channel is not a forum when the parent isn't a forum", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "text", parentChannelId: null, creatorId: "u1", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: true,
    })
    const res = await GET(req("?type=post"), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("channel is not a forum")
  })

  it("groups participants ordered by addedAt (creator first)", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "Multi", type: "post", messageCount: 3, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])
    mockListParticipantsForChannels.mockResolvedValue([
      { channelId: "post1", userId: "u_carol", addedAt: "2026-07-01T00:01:00.000Z", userName: "Carol", userImage: null },
      { channelId: "post1", userId: "u_alice", addedAt: "2026-07-01T00:00:00.000Z", userName: "Alice", userImage: null },
    ])
    const res = await GET(req("?type=post"), ctx)
    const body = await res.json()
    expect(body.children[0].participants.map((m: { id: string }) => m.id)).toEqual(["u_alice", "u_carol"])
  })
})

describe("GET /children?type=thread", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "text", parentChannelId: null, creatorId: null, tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: null },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: false,
    })
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
    mockGetUsersByIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
  })

  it("returns { children } with parentSeq and raw messageCount", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "t-A", name: "A", type: "thread", messageCount: 3, lastMessageAt: "2026-06-30T01:00:00.000Z", createdAt: "2026-06-30T00:00:00.000Z", parentMessageId: "msg-p", creatorId: null },
      { id: "t-B", name: "B", type: "thread", messageCount: 2, lastMessageAt: null, createdAt: "2026-06-30T00:00:00.000Z", parentMessageId: null, creatorId: "u-b" },
    ])
    mockGetMessagesByIds.mockResolvedValue([{ id: "msg-p", content: "parent-content", authorName: "Alice", seq: 7 }])
    mockGetUsersByIds.mockResolvedValue([{ id: "u-b", name: "Bob" }])
    mockGetFirstMessageByChannelIds.mockResolvedValue([{ channelId: "t-B", content: "first-in-B" }])

    const res = await GET(req("?type=thread"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    const a = body.children.find((t: { id: string }) => t.id === "t-A")
    const b = body.children.find((t: { id: string }) => t.id === "t-B")
    // raw messageCount (no opener subtraction)
    expect(a.messageCount).toBe(3)
    expect(a.parentSeq).toBe(7)
    expect(a.parent).toEqual({ authorName: "Alice", text: "parent-content" })
    // creator-rooted thread: no parentSeq key
    expect(Object.keys(b)).not.toContain("parentSeq")
    expect(b.parent).toEqual({ authorName: "Bob", text: "first-in-B" })
  })

  it("passes the ?archived tri-state through (true)", async () => {
    mockListChildChannels.mockResolvedValue([])
    await GET(req("?type=thread&archived=true"), ctx)
    expect(mockListChildChannels).toHaveBeenCalledWith(expect.anything(), "ch1", { archived: true, type: "thread" })
  })

  it("passes ?archived=false through", async () => {
    mockListChildChannels.mockResolvedValue([])
    await GET(req("?type=thread&archived=false"), ctx)
    expect(mockListChildChannels).toHaveBeenCalledWith(expect.anything(), "ch1", { archived: false, type: "thread" })
  })

  it("omits archived when not provided (undefined)", async () => {
    mockListChildChannels.mockResolvedValue([])
    await GET(req("?type=thread"), ctx)
    expect(mockListChildChannels).toHaveBeenCalledWith(expect.anything(), "ch1", { archived: undefined, type: "thread" })
  })
})
