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
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1" })
    // requireChannelAccess resolves through resolveChannelAccessContext — a
    // public channel the caller is a member of.
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: null },
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

  it("filters only the scoped child opener candidates for a normalized tag", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "post_1", parentMessageId: "opener_1" },
      { id: "post_2", parentMessageId: "opener_2" },
      { id: "plain_thread", parentMessageId: null },
    ])
    mockFilterMessageIdsByTag.mockResolvedValue(["opener_2"])

    const res = await GET(req("http://localhost/api/community/channels/c1/threads?tag=%20BUG%20"), ctx)
    expect(res.status).toBe(200)
    expect(mockFilterMessageIdsByTag).toHaveBeenCalledWith(expect.anything(), ["opener_1", "opener_2"], "bug")
    expect((await res.json()).threads).toEqual([{ id: "post_2", parentMessageId: "opener_2" }])
  })

  it("rejects an empty tag before querying message_tags", async () => {
    mockListChildChannels.mockResolvedValue([])
    const res = await GET(req("http://localhost/api/community/channels/c1/threads?tag=%20%20"), ctx)
    expect(res.status).toBe(400)
    expect(mockFilterMessageIdsByTag).not.toHaveBeenCalled()
  })
})
