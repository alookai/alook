import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetChannelForMember = vi.fn()
const mockResolveChannelAccessContext = vi.fn()
const mockCreateMessageWithThread = vi.fn()
const mockFindPendingAttachmentsForSender = vi.fn(async () => [])
const mockGetUserSelf = vi.fn()
const mockListChildChannels = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockGetMessagesByIds = vi.fn(async () => [] as unknown[])
const mockGetFirstMessageByChannelIds = vi.fn(async () => [] as unknown[])
const mockListParticipantsForChannels = vi.fn(async () => [] as unknown[])
const mockListTagsForMessages = vi.fn(async () => [] as unknown[])

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
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
      },
      communityMessage: {
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        getFirstMessageByChannelIds: (...a: unknown[]) => mockGetFirstMessageByChannelIds(...a),
      },
      communityMessageTag: {
        listTagsForMessages: (...a: unknown[]) => mockListTagsForMessages(...a),
      },
      communityAttachment: {
        // Reserve-by-id: the post route validates pending ids via findPending,
        // then createMessageWithThread reserves them onto the reply message.
        findPendingAttachmentsForSender: (...a: unknown[]) => mockFindPendingAttachmentsForSender(...a),
      },
      communityThread: {
        listParticipantsForChannels: (...a: unknown[]) => mockListParticipantsForChannels(...a),
      },
      user: {
        getUserSelf: (...a: unknown[]) => mockGetUserSelf(...a),
        getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/create-channels", () => ({
  createMessageWithThread: (...a: unknown[]) => mockCreateMessageWithThread(...a),
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

// A post is now a thread rooted directly under a forum: title lands as the
// opener message (in the forum), content as the thread's first reply, both
// via the SAME createMessageWithThread primitive the bot send-into-forum
// path uses. Route-level tests mock that primitive directly (it's unit-
// tested on its own in create-channels.test.ts) and assert the route's own
// validation + response projection.
function successResult(overrides: Partial<{ threadId: string; threadName: string; messageContent: string; replyCreatedAt: string; messageCreatedAt: string }> = {}) {
  const {
    threadId = "post1",
    threadName = "my-thoughts-on-this",
    messageContent = "My thoughts on this!",
    replyCreatedAt = "2026-07-02T00:00:01.000Z",
    messageCreatedAt = "2026-07-02T00:00:00.000Z",
  } = overrides
  return {
    ok: true,
    message: { id: "m_opener", content: messageContent, createdAt: messageCreatedAt },
    attachments: [],
    thread: { id: threadId, name: threadName, createdAt: messageCreatedAt },
    reply: { id: "m_reply", content: "hello", createdAt: replyCreatedAt },
    replyAttachments: [],
  }
}

describe("POST /api/community/channels/[id]/posts — name normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "ch1", serverId: "s1", type: "forum", tags: [] })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
    mockCreateMessageWithThread.mockResolvedValue(successResult())
  })

  it("passes the trimmed title as the opener body and content as the reply body", async () => {
    const res = await POST(postReq({ name: "My thoughts on this!", content: "hello" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({
        parentChannelId: "ch1",
        body: { content: "My thoughts on this!", mentionType: undefined },
        replyBody: { content: "hello" },
      }),
    )
  })

  it("returns 400 (and never calls createMessageWithThread) when the post title is all disallowed characters", async () => {
    const res = await POST(postReq({ name: "   ", content: "hello" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("returns 400 (and never calls createMessageWithThread) when the title exceeds MAX_CHANNEL_NAME_LENGTH", async () => {
    const res = await POST(postReq({ name: "x".repeat(200), content: "hello" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("returns messageCount 0 in the response (a fresh post has no replies beyond its own body)", async () => {
    const res = await POST(postReq({ name: "solo", content: "hi" }), ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.post.messageCount).toBe(0)
  })

  it("the response id is the thread's id (the post channel)", async () => {
    mockCreateMessageWithThread.mockResolvedValue(successResult({ threadId: "thread_xyz" }))
    const res = await POST(postReq({ name: "solo", content: "hi" }), ctx)
    const body = await res.json()
    expect(body.post.id).toBe("thread_xyz")
  })
})

describe("POST /api/community/channels/[id]/posts — content + attachments contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "ch1", serverId: "s1", type: "forum", tags: [] })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
    mockCreateMessageWithThread.mockResolvedValue(successResult())
  })

  it("empty content + zero attachments returns 400 — the reply body is required (matches the composer's existing disabled-submit behavior)", async () => {
    const res = await POST(postReq({ name: "my post", content: "" }), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("post body is required")
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("empty content + one valid attachment is STILL rejected — attachments alone don't satisfy the required reply body", async () => {
    // Per Gener/Aigneis's ruling: the human posts route now matches the bot
    // send-into-forum path's replyContent-required contract — attachment-only
    // posts are no longer supported (the live composer already disabled
    // submit without body text before this route even existed). Content is
    // validated BEFORE attachments, so findPendingAttachmentsForSender is
    // never even reached here.
    const res = await POST(postReq({ name: "img", content: "", attachments: ["att_1"] }), ctx)
    expect(res.status).toBe(400)
    expect(mockFindPendingAttachmentsForSender).not.toHaveBeenCalled()
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("attachments are validated then passed through as replyAttachmentIds (they land on the reply, not the opener)", async () => {
    mockFindPendingAttachmentsForSender.mockResolvedValueOnce([{ id: "att_1" }])
    const res = await POST(postReq({ name: "img", content: "check this out", attachments: ["att_1"] }), ctx)
    expect(res.status).toBe(201)
    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: ["att_1"], uploaderId: "u1", targetId: "ch1" }),
    )
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({ replyAttachmentIds: ["att_1"], attachmentIds: undefined }),
    )
  })

  it("rejects when an attachment id doesn't validate against (uploader, target)", async () => {
    mockFindPendingAttachmentsForSender.mockResolvedValueOnce([]) // none matched
    const res = await POST(postReq({ name: "img", content: "hi", attachments: ["att_bad"] }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("threads mentionType through to createMessageWithThread's opener body", async () => {
    const res = await POST(
      postReq({ name: "heads up", content: "Heads up @everyone", mentionType: "everyone" }),
      ctx,
    )
    expect(res.status).toBe(201)
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({ body: { content: "heads up", mentionType: "everyone" } }),
    )
  })

  it("propagates a createMessageWithThread failure as the route's error response", async () => {
    mockCreateMessageWithThread.mockResolvedValue({ ok: false, status: 404, error: "thread not found" })
    const res = await POST(postReq({ name: "img", content: "hi" }), ctx)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("thread not found")
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
    mockGetMessagesByIds.mockResolvedValue([])
    mockListTagsForMessages.mockResolvedValue([])
  })

  function getReq() {
    return new NextRequest("http://localhost/api/community/channels/ch1/posts")
  }

  it("carries each post's creatorId through as authorId", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "First", messageCount: 2, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", parentMessageId: "m_opener1", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m_opener1", content: "First" }])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts).toHaveLength(1)
    expect(body.posts[0].authorId).toBe("u_alice")
  })

  it("falls back to an empty authorId when the creator was deleted (creatorId null)", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "Orphan", messageCount: 0, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: null, parentMessageId: "m_opener1", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m_opener1", content: "Orphan" }])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts[0].authorId).toBe("")
  })

  it("reads the post's title from its opener message's content, not the channel's own name column", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "post1-slug", messageCount: 1, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", parentMessageId: "m_opener1", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m_opener1", content: "My Real Title" }])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.posts[0].name).toBe("My Real Title")
  })

  it("reads tags from message_tags via the opener message id, not a channel column", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "post1-slug", messageCount: 1, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", parentMessageId: "m_opener1", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_alice", name: "Alice", image: null }])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m_opener1", content: "Tagged" }])
    mockListTagsForMessages.mockResolvedValue([{ messageId: "m_opener1", tag: "alpha" }, { messageId: "m_opener1", tag: "beta" }])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.posts[0].tags.sort()).toEqual(["alpha", "beta"])
  })

  it("filters by ?tag= after tags are hydrated from message_tags", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "p1", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u1", parentMessageId: "m1", tags: [] },
      { id: "post2", name: "p2", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u1", parentMessageId: "m2", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m1", content: "p1" }, { id: "m2", content: "p2" }])
    mockListTagsForMessages.mockResolvedValue([{ messageId: "m1", tag: "alpha" }])

    const res = await GET(new NextRequest("http://localhost/api/community/channels/ch1/posts?tag=alpha"), ctx)
    const body = await res.json()
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual(["post1"])
  })

  it("groups each post's participants onto its card, ordered by addedAt (creator first)", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post1", name: "Multi", messageCount: 3, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_alice", parentMessageId: "m_opener1", tags: [] },
      { id: "post2", name: "Solo", messageCount: 1, lastMessageAt: "2026-07-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_bob", parentMessageId: "m_opener2", tags: [] },
    ])
    mockGetUsersByIds.mockResolvedValue([
      { id: "u_alice", name: "Alice", image: null },
      { id: "u_bob", name: "Bob", image: null },
    ])
    mockGetMessagesByIds.mockResolvedValue([
      { id: "m_opener1", content: "Multi" },
      { id: "m_opener2", content: "Solo" },
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
    { id: "p_mine", name: "Mine", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_other", parentMessageId: "m1", tags: [] },
    { id: "p_hidden", name: "Secret", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u_other", parentMessageId: "m2", tags: [] },
    { id: "p_created", name: "By me", messageCount: 1, lastMessageAt: null, createdAt: "2026-07-01T00:00:00.000Z", creatorId: "u1", parentMessageId: "m3", tags: [] },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFirstMessageByChannelIds.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
    mockListTagsForMessages.mockResolvedValue([])
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
