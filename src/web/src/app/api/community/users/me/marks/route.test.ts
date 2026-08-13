import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListMarksForUser = vi.fn()
const mockGetChannelsByIds = vi.fn()
const mockGetServersByIds = vi.fn()
const mockListAccessVisibleChannelIds = vi.fn()
const mockToAgentMessages = vi.fn()
const mockListByMessageIds = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessageMark: {
        listMarksForUser: (...args: unknown[]) => mockListMarksForUser(...args),
      },
      communityAgentInbox: {
        listAccessVisibleChannelIdsForUser: (...args: unknown[]) => mockListAccessVisibleChannelIds(...args),
        toAgentMessages: (...args: unknown[]) => mockToAgentMessages(...args),
      },
      communityAttachment: {
        listByMessageIds: (...args: unknown[]) => mockListByMessageIds(...args),
      },
      communityChannel: {
        getChannelsByIds: (...args: unknown[]) => mockGetChannelsByIds(...args),
      },
      communityServer: {
        getServersByIds: (...args: unknown[]) => mockGetServersByIds(...args),
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

vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const bot = req.headers.get("x-test-actor") === "bot"
    return handler(req, {
      env: { DB: {} },
      actor: bot
        ? { kind: "bot", userId: "bot_1", ownerUserId: "u1", machineId: "machine_1" }
        : { kind: "human", userId: "u1", email: "u@t.com" },
      params,
    })
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

describe("GET /api/community/users/me/marks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelsByIds.mockResolvedValue([])
    mockGetServersByIds.mockResolvedValue([])
    mockListAccessVisibleChannelIds.mockResolvedValue(["c1"])
    mockListByMessageIds.mockResolvedValue([])
    mockToAgentMessages.mockResolvedValue([])
  })

  it("scopes the query to the viewer's visible channels (no leak of left private channels)", async () => {
    mockListMarksForUser.mockResolvedValue([])
    await GET(new NextRequest("http://localhost/api/community/users/me/marks"))
    const opts = mockListMarksForUser.mock.calls[0][2]
    expect(opts.visibleChannelIds).toEqual(["c1"])
  })

  it("unions the viewer's DM channels into scope so marked DM messages are not filtered out", async () => {
    // DM channels carry server_id=NULL and are absent from
    // listVisibleChannelIdsForUser — without the union a marked DM message would
    // be silently dropped from the Marked tab (Gus /Gus/working #1025).
    mockListAccessVisibleChannelIds.mockResolvedValue(["c1", "dm1"])
    mockListMarksForUser.mockResolvedValue([])
    await GET(new NextRequest("http://localhost/api/community/users/me/marks"))
    const opts = mockListMarksForUser.mock.calls[0][2]
    expect(opts.visibleChannelIds).toEqual(["c1", "dm1"])
  })

  it("hydrates server + channel names and carries the seq jump key + snapshot", async () => {
    mockListMarksForUser.mockResolvedValue([
      {
        mark: { id: "mk1", channelId: "c1", createdAt: "2026-06-25T10:00:00Z" },
        message: { id: "m1", seq: 42, content: "pinned thought", createdAt: "2026-06-25T09:00:00Z" },
        author: { id: "u-alice", name: "Alice", email: "alice@t.com", image: null },
      },
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])
    mockGetServersByIds.mockResolvedValue([{ id: "s1", name: "Server 1" }])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/marks"))
    const body = await res.json()
    expect(body.marked).toHaveLength(1)
    expect(body.marked[0]).toMatchObject({
      id: "mk1",
      server: "Server 1",
      serverId: "s1",
      channel: "general",
      channelId: "c1",
      // serverId + channelId locate the channel, m.seq jumps to the message —
      // all three required for cross-channel navigation. seq lives inside `m`
      // to match the frontend `Marked` type (m: Msg).
      m: { id: "m1", authorId: "u-alice", authorName: "Alice", content: "pinned thought", seq: 42 },
    })
  })

  it("returns empty marked array when none", async () => {
    mockListMarksForUser.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/marks"))
    expect((await res.json()).marked).toEqual([])
  })

  it("clamps over-cap limit and forwards it to the query", async () => {
    mockListMarksForUser.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/marks?limit=99999"))
    const body = await res.json()
    expect(body.limit).toBe(200) // MAX_INBOX_PAGE_SIZE
    expect(mockListMarksForUser).toHaveBeenCalledWith({}, "u1", { limit: 200, visibleChannelIds: ["c1"] })
  })

  it("bot list is self-scoped, unbounded, attachment-batched, and agent-projected", async () => {
    const message = {
      id: "m1", authorId: "u-alice", channelId: "c1", seq: 42,
      content: "task", createdAt: "2026-06-25T09:00:00Z", replyToId: "m0",
    }
    mockListMarksForUser.mockResolvedValue([{ mark: { id: "mk1", channelId: "c1" }, message, author: {} }])
    mockListByMessageIds.mockResolvedValue([{ id: "att1", messageId: "m1", filename: "proof.png", contentType: "image/png", size: 12 }])
    mockToAgentMessages.mockResolvedValue([{ seq: "#42", channel: "/s#0001/c", content: { text: "task" } }])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/marks?limit=1", {
      headers: { "x-test-actor": "bot" },
    }))
    expect(await res.json()).toEqual({
      marked: [{ seq: "#42", channel: "/s#0001/c", content: { text: "task" } }],
    })
    expect(mockListMarksForUser).toHaveBeenCalledWith({}, "bot_1", {
      visibleChannelIds: ["c1"],
    })
    expect(mockListByMessageIds).toHaveBeenCalledOnce()
    expect(mockListByMessageIds).toHaveBeenCalledWith({}, ["m1"])
    expect(mockToAgentMessages).toHaveBeenCalledWith(
      {},
      [message],
      "bot_1",
      expect.any(Map),
    )
  })

  it("bot list fails strictly when its marks query fails", async () => {
    mockListMarksForUser.mockRejectedValue(new Error("D1 hard failure"))
    const request = new NextRequest("http://localhost/api/community/users/me/marks", {
      headers: { "x-test-actor": "bot" },
    })
    await expect(GET(request)).rejects.toThrow("D1 hard failure")
  })
})
