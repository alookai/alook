import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListUnreadMentions = vi.fn()
const mockGetChannelsByIds = vi.fn()
const mockGetServersByIds = vi.fn()
const mockListVisibleChannelIds = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMention: {
        listUnreadMentions: (...args: unknown[]) => mockListUnreadMentions(...args),
      },
      communityChannel: {
        getChannelsByIds: (...args: unknown[]) => mockGetChannelsByIds(...args),
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIds(...args),
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

describe("GET /api/community/inbox/mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelsByIds.mockResolvedValue([])
    mockGetServersByIds.mockResolvedValue([])
    mockListVisibleChannelIds.mockResolvedValue(["c1"])
  })

  it("queries BOTH mention + reply kinds (no kind filter) scoped to visible channels", async () => {
    mockListUnreadMentions.mockResolvedValue([])
    await GET(new NextRequest("http://localhost/api/community/inbox/mentions"))
    // No `kind` narrowing — both @-mentions and reply notifications surface.
    const opts = mockListUnreadMentions.mock.calls[0][2]
    expect(opts.kind).toBeUndefined()
    expect(opts.visibleChannelIds).toEqual(["c1"])
  })

  it("hydrates server + channel names and the mention kind into the response", async () => {
    mockListUnreadMentions.mockResolvedValue([
      {
        mention: { id: "mn1", kind: "mention" },
        message: { id: "m1", channelId: "c1", content: "@u1 hi", createdAt: "2026-06-25T10:00:00Z" },
        author: { name: "Alice", email: "alice@t.com", image: null },
      },
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])
    mockGetServersByIds.mockResolvedValue([{ id: "s1", name: "Server 1" }])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/mentions"))
    const body = await res.json()
    expect(body.mentions).toHaveLength(1)
    expect(body.mentions[0]).toMatchObject({
      id: "mn1",
      kind: "mention",
      server: "Server 1",
      serverId: "s1",
      channel: "general",
      channelId: "c1",
      m: { id: "m1", authorName: "Alice", content: "@u1 hi" },
    })
  })

  it("tags reply-kind rows so the UI can label them 'replied to you'", async () => {
    mockListUnreadMentions.mockResolvedValue([
      {
        mention: { id: "mn2", kind: "reply" },
        message: { id: "m2", channelId: "c1", content: "sure", createdAt: "2026-06-25T11:00:00Z" },
        author: { name: "Bob", email: "bob@t.com", image: null },
      },
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])
    mockGetServersByIds.mockResolvedValue([{ id: "s1", name: "Server 1" }])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/mentions"))
    const body = await res.json()
    expect(body.mentions[0].kind).toBe("reply")
  })

  it("returns empty mentions array when none", async () => {
    mockListUnreadMentions.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/mentions"))
    const body = await res.json()
    expect(body.mentions).toEqual([])
  })

  it("clamps over-cap limit and forwards it to the query", async () => {
    mockListUnreadMentions.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/mentions?limit=99999"))
    const body = await res.json()
    expect(body.limit).toBe(200) // MAX_INBOX_PAGE_SIZE
    expect(mockListUnreadMentions).toHaveBeenCalledWith({}, "u1", { limit: 200, visibleChannelIds: ["c1"] })
  })
})
