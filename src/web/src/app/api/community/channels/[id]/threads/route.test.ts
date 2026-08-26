import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetMember = vi.fn()
const mockResolveChannelAccessContext = vi.fn()
const mockListChildChannels = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockGetFirstMessageByChannelIds = vi.fn()
const mockGetMessage = vi.fn()
const mockGetUser = vi.fn()
const mockListMessages = vi.fn()
const mockFilterMessageIdsByTag = vi.fn()
const mockListTagsForMessages = vi.fn()
const mockListForumThreadsByCreatedAt = vi.fn()
const mockListParticipantsForChannels = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
      },
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        getFirstMessageByChannelIds: (...a: unknown[]) => mockGetFirstMessageByChannelIds(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      communityMessageTag: {
        filterMessageIdsByTag: (...a: unknown[]) => mockFilterMessageIdsByTag(...a),
        listTagsForMessages: (...a: unknown[]) => mockListTagsForMessages(...a),
      },
      communityThread: {
        listForumThreadsByCreatedAt: (...a: unknown[]) => mockListForumThreadsByCreatedAt(...a),
        listParticipantsForChannels: (...a: unknown[]) => mockListParticipantsForChannels(...a),
      },
      user: {
        getUser: (...a: unknown[]) => mockGetUser(...a),
        getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
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

function req(url = "http://localhost/api/community/channels/c1/threads") {
  return new NextRequest(url, { method: "GET" })
}

const ctx = { params: { id: "c1" } } as any

describe("GET /api/community/channels/[id]/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFilterMessageIdsByTag.mockResolvedValue([])
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1" })
    // requireChannelAccess resolves through resolveChannelAccessContext — a
    // public channel the caller is a member of.
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null, type: "forum" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null, type: "forum" },
      role: "member",
      isPrivate: false,
      isChannelMember: false,
    })
  })

  it("returns plain child-thread rows without a view-specific hydration facade", async () => {
    // Fixture: 3 threads.
    //   thread-A: parent message (parentMessageId set)
    //   thread-B: creator only, has a first message
    //   thread-C: creator only, no first message
    mockListChildChannels.mockResolvedValue([
      {
        id: "t-A",
        name: "A",
        type: "thread",
        messageCount: 3,
        lastMessageAt: "2026-06-30T01:00:00.000Z",
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: "msg-p",
        creatorId: null,
      },
      {
        id: "t-B",
        name: "B",
        type: "thread",
        messageCount: 2,
        lastMessageAt: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: null,
        creatorId: "u-b",
      },
      {
        id: "t-C",
        name: "C",
        type: "thread",
        messageCount: 1,
        lastMessageAt: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: null,
        creatorId: "u-c",
      },
    ])
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { threads: Array<{ id: string; parentMessageId: string | null }> }

    expect((body as typeof body & { parentType: string }).parentType).toBe("forum")
    expect((body as typeof body & { serverId: string }).serverId).toBe("s1")

    expect(body.threads).toEqual([
      { id: "t-A", name: "A", type: "thread", messageCount: 3, lastMessageAt: "2026-06-30T01:00:00.000Z", createdAt: "2026-06-30T00:00:00.000Z", parentMessageId: "msg-p", creatorId: null },
      { id: "t-B", name: "B", type: "thread", messageCount: 2, lastMessageAt: null, createdAt: "2026-06-30T00:00:00.000Z", parentMessageId: null, creatorId: "u-b" },
      { id: "t-C", name: "C", type: "thread", messageCount: 1, lastMessageAt: null, createdAt: "2026-06-30T00:00:00.000Z", parentMessageId: null, creatorId: "u-c" },
    ])
    expect(mockGetMessagesByIds).not.toHaveBeenCalled()
    expect(mockGetUsersByIds).not.toHaveBeenCalled()
    expect(mockGetFirstMessageByChannelIds).not.toHaveBeenCalled()

    // Ensure the deprecated per-item fetches never fire.
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  it("keeps non-forum child collections unchanged without querying archive tags", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null, type: "text" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null, type: "text" },
      role: "member",
      isPrivate: false,
      isChannelMember: false,
    })
    mockListChildChannels.mockResolvedValue([
      { id: "thread_1", parentMessageId: "opener_1" },
      { id: "thread_2", parentMessageId: null },
    ])

    const res = await GET(req(), ctx)

    expect(res.status).toBe(200)
    expect((await res.json()).threads).toEqual([
      { id: "thread_1", parentMessageId: "opener_1" },
      { id: "thread_2", parentMessageId: null },
    ])
    expect(mockFilterMessageIdsByTag).not.toHaveBeenCalled()
  })

  it("filters only the scoped child opener candidates for a normalized tag", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post_1", parentMessageId: "opener_1" },
      { id: "post_2", parentMessageId: "opener_2" },
      { id: "plain_thread", parentMessageId: null },
    ])
    mockFilterMessageIdsByTag
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["opener_2"])

    const res = await GET(req("http://localhost/api/community/channels/c1/threads?tag=%20BUG%20"), ctx)
    expect(res.status).toBe(200)
    expect(mockFilterMessageIdsByTag).toHaveBeenNthCalledWith(1, expect.anything(), ["opener_1", "opener_2"], "archived")
    expect(mockFilterMessageIdsByTag).toHaveBeenNthCalledWith(2, expect.anything(), ["opener_1", "opener_2"], "bug")
    expect((await res.json()).threads).toEqual([{ id: "post_2", parentMessageId: "opener_2" }])
  })

  it("reuses the archive opener set for the legacy Archived tag filter", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post_1", parentMessageId: "opener_1" },
      { id: "post_2", parentMessageId: "opener_2" },
      { id: "plain_thread", parentMessageId: null },
    ])
    mockFilterMessageIdsByTag.mockResolvedValueOnce(["opener_1"])

    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?tag=%20ARCHIVED%20",
    ), ctx)

    expect(res.status).toBe(200)
    expect(mockFilterMessageIdsByTag).toHaveBeenCalledTimes(1)
    expect(mockFilterMessageIdsByTag).toHaveBeenCalledWith(
      expect.anything(),
      ["opener_1", "opener_2"],
      "archived",
    )
    expect((await res.json()).threads).toEqual([{ id: "post_1", parentMessageId: "opener_1" }])
  })

  it("rejects an empty tag before querying message_tags", async () => {
    mockListChildChannels.mockResolvedValue([])
    const res = await GET(req("http://localhost/api/community/channels/c1/threads?tag=%20%20"), ctx)
    expect(res.status).toBe(400)
    expect(mockFilterMessageIdsByTag).not.toHaveBeenCalled()
  })

  it.each(["activity", "newest", "createdat"])("rejects unsupported order=%s instead of falling through", async (order) => {
    const res = await GET(req(`http://localhost/api/community/channels/c1/threads?order=${order}`), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid order" })
    expect(mockListChildChannels).not.toHaveBeenCalled()
    expect(mockListForumThreadsByCreatedAt).not.toHaveBeenCalled()
  })

  it("returns a created-order page with scoped included resources and an opaque next cursor", async () => {
    mockListForumThreadsByCreatedAt.mockResolvedValue([
      { id: "t3", parentMessageId: "m3", createdAt: "2026-08-08T03:00:00.000Z", activityAt: "2026-08-10T03:00:00.000Z" },
      { id: "t2", parentMessageId: "m2", createdAt: "2026-08-08T02:00:00.000Z", activityAt: "2026-08-11T02:00:00.000Z" },
      { id: "t1", parentMessageId: "m1", createdAt: "2026-08-08T01:00:00.000Z", activityAt: "2026-08-12T01:00:00.000Z" },
    ])
    mockGetMessagesByIds.mockResolvedValue([{ id: "m3" }, { id: "m2" }])
    mockGetFirstMessageByChannelIds.mockResolvedValue([{ channelId: "t3", content: "preview" }])
    mockListTagsForMessages.mockResolvedValue([{ messageId: "m3", tag: "bug" }])
    mockListParticipantsForChannels.mockResolvedValue([{ channelId: "t3", userId: "u1" }])

    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt&limit=2&include=parentMessage,firstMessage,tags,participants",
    ), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.threads.map((thread: { id: string }) => thread.id)).toEqual(["t3", "t2"])
    expect(body).toMatchObject({
      parentType: "forum",
      serverId: "s1",
      hasMore: true,
      included: {
        parentMessages: [{ id: "m3" }, { id: "m2" }],
        firstMessages: [{ channelId: "t3", content: "preview" }],
        tags: [{ messageId: "m3", tag: "bug" }],
        participants: [{ channelId: "t3", userId: "u1" }],
      },
    })
    expect(body.nextCursor).toEqual(expect.any(String))
    expect(mockListForumThreadsByCreatedAt).toHaveBeenCalledWith(expect.anything(), {
      parentChannelId: "c1",
      limit: 3,
    })
    expect(mockGetMessagesByIds).toHaveBeenCalledWith(expect.anything(), ["m3", "m2"])
    expect(mockGetFirstMessageByChannelIds).toHaveBeenCalledWith(expect.anything(), ["t3", "t2"])
    expect(mockListParticipantsForChannels).toHaveBeenCalledWith(expect.anything(), ["t3", "t2"], 5)

    mockListForumThreadsByCreatedAt.mockResolvedValue([])
    const next = await GET(req(
      `http://localhost/api/community/channels/c1/threads?order=createdAt&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`,
    ), ctx)
    expect(next.status).toBe(200)
    expect(mockListForumThreadsByCreatedAt).toHaveBeenLastCalledWith(expect.anything(), {
      parentChannelId: "c1",
      cursor: { createdAt: "2026-08-08T02:00:00.000Z", id: "t2" },
      limit: 3,
    })
  })

  it("applies a normalized tag before created-order pagination", async () => {
    mockListForumThreadsByCreatedAt.mockResolvedValue([])
    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt&tag=%20BUG%20&limit=5",
    ), ctx)
    expect(res.status).toBe(200)
    expect(mockListForumThreadsByCreatedAt).toHaveBeenCalledWith(expect.anything(), {
      parentChannelId: "c1",
      tag: "bug",
      limit: 6,
    })
    expect(mockListChildChannels).not.toHaveBeenCalled()
    expect(mockFilterMessageIdsByTag).not.toHaveBeenCalled()
  })

  it("passes the archive system tag through the created-order query scope", async () => {
    mockListForumThreadsByCreatedAt.mockResolvedValue([])
    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt&tag=%20ARCHIVED%20&limit=5",
    ), ctx)
    expect(res.status).toBe(200)
    expect(mockListForumThreadsByCreatedAt).toHaveBeenCalledWith(expect.anything(), {
      parentChannelId: "c1",
      tag: "archived",
      limit: 6,
    })
  })

  it("rejects malformed and cross-forum created-order cursors without querying children", async () => {
    const malformed = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt&cursor=not-a-cursor",
    ), ctx)
    expect(malformed.status).toBe(400)

    const foreignPayload = btoa(encodeURIComponent(JSON.stringify({
      parentChannelId: "another-forum",
      createdAt: "2026-08-08T02:00:00.000Z",
      id: "t2",
      tag: null,
    }))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    const foreign = await GET(req(
      `http://localhost/api/community/channels/c1/threads?order=createdAt&cursor=${foreignPayload}`,
    ), ctx)
    expect(foreign.status).toBe(400)
    expect(mockListForumThreadsByCreatedAt).not.toHaveBeenCalled()
  })

  it("rejects unknown included resources before querying children", async () => {
    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt&include=parentMessage,secrets",
    ), ctx)
    expect(res.status).toBe(400)
    expect(mockListForumThreadsByCreatedAt).not.toHaveBeenCalled()
  })

  it("does not query created-order children when the forum access gate rejects the viewer", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", type: "forum" },
      anchor: { id: "c1", serverId: "s1", type: "forum" },
      role: "member",
      isPrivate: true,
      isCreator: false,
      isChannelMember: false,
    })
    const res = await GET(req(
      "http://localhost/api/community/channels/c1/threads?order=createdAt",
    ), ctx)
    expect(res.status).toBe(403)
    expect(mockListForumThreadsByCreatedAt).not.toHaveBeenCalled()
    expect(mockGetMessagesByIds).not.toHaveBeenCalled()
  })
})
