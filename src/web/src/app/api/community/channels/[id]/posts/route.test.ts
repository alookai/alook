import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetChannelForMember = vi.fn()
const mockResolveChannelAccessContext = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetUserSelf = vi.fn()
const mockGetUserInternal = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockListChildChannels = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockGetFirstMessageByChannelIds = vi.fn()
const mockListParticipantsForChannels = vi.fn(async () => [] as unknown[])

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
        // createCommunityMessage's private-channel scoping guard is only hit
        // when there are mentions; the happy-path posts have none, so these
        // return public/empty.
        isChannelPrivate: vi.fn(async () => false),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getFirstMessageByChannelIds: (...a: unknown[]) => mockGetFirstMessageByChannelIds(...a),
      },
      communityMember: {
        listMembers: vi.fn(async () => []),
        listMemberUserIds: vi.fn(async () => []),
      },
      communityMention: {
        createMentions: vi.fn(async () => []),
      },
      communityAttachment: {
        createAttachment: vi.fn(async (_db: unknown, args: Record<string, unknown>) => ({
          id: "att_1",
          filename: args.filename,
          r2Key: args.r2Key,
          contentType: args.contentType,
          size: args.size,
          width: args.width,
          height: args.height,
        })),
        listByMessageIds: vi.fn(async () => []),
        unreserveAttachments: vi.fn(async () => {}),
      },
      communityThread: {
        addThreadParticipants: vi.fn(async () => {}),
        listParticipantsForChannels: (...a: unknown[]) => mockListParticipantsForChannels(...a),
      },
      user: {
        getUserSelf: (...a: unknown[]) => mockGetUserSelf(...a),
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: vi.fn(async () => {}),
}))

// createCommunityMessage's non-fanout side effects — stub so the pipeline runs.
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn(async () => {}),
}))
vi.mock("@/lib/community/audit", () => ({
  logAudit: vi.fn(),
  COMMUNITY_AUDIT_ACTIONS: { MESSAGE_AUTHORED_AS_BOT: "message_authored_as_bot" },
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { GET, POST } from "./route"

const ctx = { params: { id: "ch1" } } as any

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/ch1/posts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/channels/[id]/posts — name normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "ch1", serverId: "s1", type: "forum", tags: [] })
    mockCreateMessage.mockResolvedValue({ id: "m1", createdAt: "2026-07-02T00:00:00.000Z" })
    // createCommunityMessage re-fetches the row via getMessage after insert.
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      channelId: "post1",
      dmConversationId: null,
      seq: 1,
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
    mockGetUserInternal.mockResolvedValue({ id: "u1", name: "Alice", isBot: false })
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  it("normalizes a spaced post title via slugify before creating the post channel", async () => {
    mockCreateChannel.mockResolvedValue({
      id: "post1",
      name: "My-thoughts-on-this!",
      createdAt: "2026-07-02T00:00:00.000Z",
    })

    const res = await POST(postReq({ name: "My thoughts on this!", content: "hello" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "My-thoughts-on-this!" }),
    )
  })

  it("returns 400 (and never calls createChannel) when the post title is all disallowed characters", async () => {
    const res = await POST(postReq({ name: "///", content: "hello" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("returns messageCount 0 in the response (body IS the first message, not a reply)", async () => {
    mockCreateChannel.mockResolvedValue({
      id: "post1",
      name: "solo",
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    const res = await POST(postReq({ name: "solo", content: "hi" }), ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.post.messageCount).toBe(0)
  })
})

describe("POST /api/community/channels/[id]/posts — content + attachments contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "ch1", serverId: "s1", type: "forum", tags: [] })
    mockCreateMessage.mockResolvedValue({ id: "m1", createdAt: "2026-07-02T00:00:00.000Z" })
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      channelId: "post1",
      dmConversationId: null,
      seq: 1,
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
    mockGetUserInternal.mockResolvedValue({ id: "u1", name: "Alice", isBot: false })
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockCreateChannel.mockResolvedValue({
      id: "post1",
      name: "my-post",
      createdAt: "2026-07-02T00:00:00.000Z",
    })
  })

  it("empty content + zero attachments returns 400", async () => {
    const res = await POST(postReq({ name: "my post", content: "" }), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("post is empty")
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("empty content + one valid attachment creates the post (attachments-only path)", async () => {
    const attachments = [
      { url: "/api/community/media/abc.png", filename: "abc.png", contentType: "image/png", size: 100, width: 10, height: 10 },
    ]
    const res = await POST(postReq({ name: "img", content: "", attachments }), ctx)
    expect(res.status).toBe(201)
    // Route passes attachments through to createCommunityMessage.
    expect(mockCreateChannel).toHaveBeenCalled()
  })

  it("threads mentionType through to createCommunityMessage / first message", async () => {
    const res = await POST(
      postReq({ name: "heads up", content: "Heads up @everyone", mentionType: "everyone" }),
      ctx,
    )
    expect(res.status).toBe(201)
    // The mock records the createMessage call — the pipeline lifts mentionType
    // out of `body` and lands it on the row.
    const call = mockCreateMessage.mock.calls[0]?.[1]
    expect(call?.mentionType).toBe("everyone")
  })
})

describe("GET /api/community/channels/[id]/posts — authorId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // GET now uses requireChannelAccess. Public forum → isPrivate:false so the
    // per-post visibility filter is skipped.
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "u1", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: true,
    })
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
  })

  function getReq() {
    return new NextRequest("http://localhost/api/community/channels/ch1/posts")
  }

  it("carries each post's creatorId through as authorId", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "First", messageCount: 2, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts).toHaveLength(1)
    expect(body.posts[0].authorId).toBe("u_alice")
  })

  it("falls back to an empty authorId when the creator was deleted (creatorId null)", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "Orphan", messageCount: 0, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: null, tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts[0].authorId).toBe("")
  })

  it("groups each post's participants onto its card, ordered by addedAt (creator first)", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "Multi", messageCount: 3, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", tags: [] },
      { id: "post2", name: "Solo", messageCount: 1, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_bob", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([
      { id: "u_alice", name: "Alice", image: null },
      { id: "u_bob", name: "Bob", image: null },
    ])
    // Rows arrive unordered; the route sorts by addedAt so the creator (earliest
    // "spoke") leads.
    mockListParticipantsForChannels.mockResolvedValue([
      { channelId: "post1", userId: "u_carol", addedAt: "2026-07-01T00:01:00.000Z", userName: "Carol", userImage: null },
      { channelId: "post1", userId: "u_alice", addedAt: "2026-07-01T00:00:00.000Z", userName: "Alice", userImage: null },
      { channelId: "post2", userId: "u_bob", addedAt: "2026-07-01T00:00:00.000Z", userName: "Bob", userImage: null },
    ])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    const multi = body.posts.find((p: { id: string }) => p.id === "post1")
    const solo = body.posts.find((p: { id: string }) => p.id === "post2")
    expect(multi.participants.map((m: { id: string }) => m.id)).toEqual(["u_alice", "u_carol"])
    expect(solo.participants.map((m: { id: string }) => m.id)).toEqual(["u_bob"])
  })
})

describe("GET /api/community/channels/[id]/posts — private-forum post visibility", () => {
  const posts = [
    { id: "p_mine", name: "Mine", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_other", tags: [] },
    { id: "p_hidden", name: "Secret", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_other", tags: [] },
    { id: "p_created", name: "By me", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u1", tags: [] },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
    mockGetUsersByIds.mockResolvedValue([])
    mockListChildChannels.mockResolvedValue(posts)
  })

  function getReq() {
    return new NextRequest("http://localhost/api/community/channels/ch1/posts")
  }

  it("a forum member sees ALL posts (unified model: posts inherit forum access)", async () => {
    // Reaching here means requireChannelAccess already granted forum access; a
    // forum member sees every post under it (no per-post filter). A non-member
    // 403s up front (next test).
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "owner", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "owner" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: false,
    })

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.posts.map((p: { id: string }) => p.id).sort()
    expect(ids).toEqual(["p_created", "p_hidden", "p_mine"]) // all posts visible
  })

  it("server admin WITH forum access sees every post", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "owner", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "owner" },
      role: "admin", isPrivate: true, isChannelMember: true, isCreator: false,
    })

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.posts).toHaveLength(3)
  })

  it("non-member is forbidden up front (no post leak)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(403)
  })

  it("forum creator sees every post (like any forum member)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "u1", tags: [] },
      anchor: { id: "ch1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await GET(getReq(), ctx)
    const body = await res.json()
    const ids = body.posts.map((p: { id: string }) => p.id).sort()
    expect(ids).toEqual(["p_created", "p_hidden", "p_mine"]) // all posts, not just their own
  })
})
