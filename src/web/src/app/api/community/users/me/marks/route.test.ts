import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListMarksForUser = vi.fn()
const mockGetChannelsByIds = vi.fn()
const mockGetServersByIds = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockListDmChannelIds = vi.fn()

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
      communityChannel: {
        getChannelsByIds: (...args: unknown[]) => mockGetChannelsByIds(...args),
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIds(...args),
      },
      communityDm: {
        listDmChannelIdsForUser: (...args: unknown[]) => mockListDmChannelIds(...args),
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
    mockListVisibleChannelIds.mockResolvedValue(["c1"])
    mockListDmChannelIds.mockResolvedValue([])
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
    mockListVisibleChannelIds.mockResolvedValue(["c1"])
    mockListDmChannelIds.mockResolvedValue(["dm1"])
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
})
