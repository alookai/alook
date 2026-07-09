import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListUnreadChannels = vi.fn()
const mockGetSettings = vi.fn()
const mockListUnreadMentions = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityInbox: {
        listUnreadChannels: (...args: unknown[]) => mockListUnreadChannels(...args),
      },
      communityNotificationSetting: {
        getSettings: (...args: unknown[]) => mockGetSettings(...args),
      },
      communityMention: {
        listUnreadMentions: (...args: unknown[]) => mockListUnreadMentions(...args),
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

function row(overrides: Partial<{ channelId: string; channelName: string; serverId: string; serverName: string; lastMessageAt: string; lastReadAt: string | null }>) {
  return {
    channelId: "c1",
    channelName: "general",
    serverId: "s1",
    serverName: "Server 1",
    lastMessageAt: "2026-06-25T10:00:00Z",
    lastReadAt: null,
    ...overrides,
  }
}

describe("GET /api/community/inbox/unreads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockResolvedValue([])
    mockListUnreadMentions.mockResolvedValue([])
  })

  it("groups channels by server", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1", channelId: "c1", channelName: "general", lastMessageAt: "2026-06-25T10:00:00Z" }),
      row({ serverId: "s1", channelId: "c2", channelName: "releases", lastMessageAt: "2026-06-25T09:00:00Z" }),
      row({ serverId: "s2", serverName: "Other", channelId: "c3", channelName: "lounge", lastMessageAt: "2026-06-25T11:00:00Z" }),
    ])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.servers).toHaveLength(2)
    // Most recent server first (s2 latest 11:00 > s1 latest 10:00)
    expect(body.servers[0].serverId).toBe("s2")
    expect(body.servers[1].serverId).toBe("s1")
    // Channels sorted within a server, most recent first
    expect(body.servers[1].channels.map((c: { channelId: string }) => c.channelId)).toEqual(["c1", "c2"])
  })

  it("filters muted servers", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1" }),
      row({ serverId: "s2", serverName: "Other", channelId: "c2", channelName: "lounge" }),
    ])
    mockGetSettings.mockResolvedValue([{ serverId: "s1", channelId: null, level: "nothing" }])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads"))
    const body = await res.json()

    expect(body.servers.map((s: { serverId: string }) => s.serverId)).toEqual(["s2"])
  })

  it("filters muted channels", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1", channelId: "c1" }),
      row({ serverId: "s1", channelId: "c2", channelName: "spam" }),
    ])
    mockGetSettings.mockResolvedValue([{ serverId: null, channelId: "c2", level: "nothing" }])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads"))
    const body = await res.json()

    expect(body.servers[0].channels.map((c: { channelId: string }) => c.channelId)).toEqual(["c1"])
  })

  it("attaches mentionCount from unread mentions per channel", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    mockListUnreadMentions.mockResolvedValue([
      { message: { channelId: "c1" } },
      { message: { channelId: "c1" } },
      { message: { channelId: "c-other" } },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads"))
    const body = await res.json()
    expect(body.servers[0].channels[0].mentionCount).toBe(2)
  })

  it("truncates by total channel count when over the limit", async () => {
    // 3 channels under one server, limit=2 → only first 2 returned, truncated=true.
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1", channelId: "c1", lastMessageAt: "2026-06-25T12:00:00Z" }),
      row({ serverId: "s1", channelId: "c2", lastMessageAt: "2026-06-25T11:00:00Z" }),
      row({ serverId: "s1", channelId: "c3", lastMessageAt: "2026-06-25T10:00:00Z" }),
    ])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads?limit=2"))
    const body = await res.json()

    expect(body.limit).toBe(2)
    expect(body.truncated).toBe(true)
    expect(body.servers[0].channels.map((c: { channelId: string }) => c.channelId)).toEqual(["c1", "c2"])
  })

  it("reports truncated=false when total channel count fits the limit", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/unreads?limit=10"))
    const body = await res.json()
    expect(body.truncated).toBe(false)
  })
})
