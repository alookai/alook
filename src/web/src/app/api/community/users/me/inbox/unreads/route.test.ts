import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListUnreadChannels = vi.fn()
const mockListUnreadForumOpeners = vi.fn()
const mockGetSettings = vi.fn()
const mockListUnreadMentions = vi.fn()
const mockListUnreadDms = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockGetChannelsByIds = vi.fn()

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
        listUnreadForumOpeners: (...args: unknown[]) => mockListUnreadForumOpeners(...args),
        listUnreadDms: (...args: unknown[]) => mockListUnreadDms(...args),
      },
      communityNotificationSetting: {
        getSettings: (...args: unknown[]) => mockGetSettings(...args),
      },
      communityMention: {
        listUnreadMentions: (...args: unknown[]) => mockListUnreadMentions(...args),
      },
      communityChannel: {
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIds(...args),
        getChannelsByIds: (...args: unknown[]) => mockGetChannelsByIds(...args),
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

function row(overrides: Partial<{ channelId: string; channelName: string; serverId: string; serverName: string; type: string | null; parentChannelId: string | null; lastMessageAt: string; lastReadAt: string | null }>) {
  return {
    channelId: "c1",
    channelName: "general",
    serverId: "s1",
    serverName: "Server 1",
    type: "text" as string | null,
    parentChannelId: null,
    lastMessageAt: "2026-06-25T10:00:00Z",
    lastReadAt: null,
    ...overrides,
  }
}

function opener(overrides: Partial<{
  forumChannelId: string
  openerMessageId: string
  childChannelId: string
  title: string
  createdAt: string
  openerSeq: number
}> = {}) {
  return {
    forumChannelId: "f1",
    openerMessageId: "m1",
    childChannelId: "p1",
    title: "Full opener content",
    createdAt: "2026-06-25T10:00:00Z",
    openerSeq: 1,
    ...overrides,
  }
}

describe("GET /api/community/users/me/inbox/unreads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockResolvedValue([])
    mockListUnreadMentions.mockResolvedValue([])
    mockListUnreadDms.mockResolvedValue([])
    mockListUnreadForumOpeners.mockResolvedValue([])
    mockListVisibleChannelIds.mockResolvedValue([])
    mockGetChannelsByIds.mockResolvedValue([])
  })

  it("groups channels by server", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1", channelId: "c1", channelName: "general", lastMessageAt: "2026-06-25T10:00:00Z" }),
      row({ serverId: "s1", channelId: "c2", channelName: "releases", lastMessageAt: "2026-06-25T09:00:00Z" }),
      row({ serverId: "s2", serverName: "Other", channelId: "c3", channelName: "lounge", lastMessageAt: "2026-06-25T11:00:00Z" }),
    ])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
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

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()

    expect(body.servers.map((s: { serverId: string }) => s.serverId)).toEqual(["s2"])
  })

  it("filters muted channels", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ serverId: "s1", channelId: "c1" }),
      row({ serverId: "s1", channelId: "c2", channelName: "spam" }),
    ])
    mockGetSettings.mockResolvedValue([{ serverId: null, channelId: "c2", level: "nothing" }])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
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
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
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

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads?limit=2"))
    const body = await res.json()

    expect(body.limit).toBe(2)
    expect(body.truncated).toBe(true)
    expect(body.servers[0].channels.map((c: { channelId: string }) => c.channelId)).toEqual(["c1", "c2"])
  })

  it("reports truncated=false when total channel count fits the limit", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads?limit=10"))
    const body = await res.json()
    expect(body.truncated).toBe(false)
  })

  it("returns unread DMs sorted most-recent first", async () => {
    mockListUnreadChannels.mockResolvedValue([])
    mockListUnreadDms.mockResolvedValue([
      { channelId: "dm_1", otherUserId: "u2", otherUserName: "Alice", otherUserImage: null, lastMessageAt: "2026-06-25T09:00:00Z" },
      { channelId: "dm_2", otherUserId: "u3", otherUserName: "Bob", otherUserImage: "https://cdn/b.png", lastMessageAt: "2026-06-25T11:00:00Z" },
    ])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.dms).toHaveLength(2)
    expect(body.dms[0].channelId).toBe("dm_2")
    expect(body.dms[0].otherUserAvatar).toBe("https://cdn/b.png")
    expect(body.dms[1].channelId).toBe("dm_1")
    // No cdn image → avatar falls back to the initial letter.
    expect(body.dms[1].otherUserAvatar).toBe("A")
  })

  it("returns empty dms array when only channels are unread", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    mockListUnreadDms.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.dms).toEqual([])
    expect(body.servers).toHaveLength(1)
  })

  it("returns dms alongside servers when both have unreads", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    mockListUnreadDms.mockResolvedValue([
      { channelId: "dm_1", otherUserId: "u2", otherUserName: "Alice", otherUserImage: null, lastMessageAt: "2026-06-25T12:00:00Z" },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.servers).toHaveLength(1)
    expect(body.dms).toHaveLength(1)
  })

  // ── Threads / forum-posts as child sub-rows ────────────────────────────────

  it("nests an unread thread under its parent channel; parent surfaces w/o direct unread", async () => {
    // Parent c1 has NO direct unread (not in the unread list); its child thread
    // t1 does. The route must batch-resolve the parent's name via getChannelsByIds.
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "t1", channelName: "budget-2026", parentChannelId: "c1", lastMessageAt: "2026-06-25T10:00:00Z" }),
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])

    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockGetChannelsByIds).toHaveBeenCalledWith(expect.anything(), ["c1"])
    expect(body.servers).toHaveLength(1)
    expect(body.servers[0].channels).toHaveLength(1)
    const parent = body.servers[0].channels[0]
    expect(parent.channelId).toBe("c1")
    expect(parent.channelName).toBe("general")
    expect(parent.children.map((c: { channelId: string }) => c.channelId)).toEqual(["t1"])
  })

  it("nests a child under a parent that ALSO has a direct unread (no re-resolve)", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "c1", channelName: "general", lastMessageAt: "2026-06-25T10:00:00Z" }),
      row({ channelId: "t1", channelName: "budget-2026", parentChannelId: "c1", lastMessageAt: "2026-06-25T11:00:00Z" }),
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    // Parent was already present → no getChannelsByIds resolve needed.
    expect(mockGetChannelsByIds).not.toHaveBeenCalled()
    const parent = body.servers[0].channels[0]
    expect(parent.channelId).toBe("c1")
    expect(parent.children.map((c: { channelId: string }) => c.channelId)).toEqual(["t1"])
  })

  it("attributes per-channel mentionCount to the correct child row", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "t1", channelName: "thread", parentChannelId: "c1" }),
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])
    mockListUnreadMentions.mockResolvedValue([
      { message: { channelId: "t1" } },
      { message: { channelId: "t1" } },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.servers[0].channels[0].children[0].mentionCount).toBe(2)
  })

  it("cascades a muted parent's mute to its unread child rows", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "t1", channelName: "thread", parentChannelId: "c1" }),
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "general", serverId: "s1" }])
    // Parent c1 muted → the whole subtree is suppressed.
    mockGetSettings.mockResolvedValue([{ serverId: null, channelId: "c1", level: "nothing" }])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.servers).toHaveLength(0)
  })

  it("counts child rows toward the truncation limit", async () => {
    // Parent c1 (weight 1) + 2 children (weight 2) = 3 rows; limit=2 → parent +
    // 1 child kept, truncated=true.
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "c1", channelName: "general", lastMessageAt: "2026-06-25T09:00:00Z" }),
      row({ channelId: "t1", channelName: "thread-1", parentChannelId: "c1", lastMessageAt: "2026-06-25T11:00:00Z" }),
      row({ channelId: "t2", channelName: "thread-2", parentChannelId: "c1", lastMessageAt: "2026-06-25T10:00:00Z" }),
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads?limit=2"))
    const body = await res.json()
    expect(body.truncated).toBe(true)
    const parent = body.servers[0].channels[0]
    expect(parent.channelId).toBe("c1")
    // Newest child first, capped to 1.
    expect(parent.children.map((c: { channelId: string }) => c.channelId)).toEqual(["t1"])
  })

  it("top-level channels carry an empty children array", async () => {
    mockListUnreadChannels.mockResolvedValue([row({ channelId: "c1" })])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.servers[0].channels[0].children).toEqual([])
  })

  // ── Entity type plumbing (drives the inbox icon) ───────────────────────────

  it("surfaces channel `type` so the inbox can pick the right entity icon", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "c1", channelName: "general", type: "text" }),
      row({ channelId: "c2", channelName: "help-forum", type: "forum", lastMessageAt: "2026-06-25T09:00:00Z" }),
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    const byId = Object.fromEntries(
      body.servers[0].channels.map((c: { channelId: string; type?: string }) => [c.channelId, c.type]),
    )
    expect(byId).toEqual({ c1: "text", c2: "forum" })
  })

  it("surfaces child `type` (thread / forum_post) on nested rows", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "c1", channelName: "general", type: "text" }),
      row({ channelId: "t1", channelName: "budget", type: "thread", parentChannelId: "c1", lastMessageAt: "2026-06-25T11:00:00Z" }),
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    const parent = body.servers[0].channels[0]
    expect(parent.type).toBe("text")
    expect(parent.children[0].type).toBe("thread")
  })

  it("carries `type` from getChannelsByIds when the parent is backfilled", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "t1", channelName: "budget", type: "thread", parentChannelId: "c1" }),
    ])
    mockGetChannelsByIds.mockResolvedValue([{ id: "c1", name: "help-forum", serverId: "s1", type: "forum" }])
    const res = await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))
    const body = await res.json()
    expect(body.servers[0].channels[0].type).toBe("forum")
  })

  // ── Per-post forum opener projection ──────────────────────────────────────

  it("queries only visible, direct-unread, unmuted top-level forum parents", async () => {
    mockListVisibleChannelIds.mockResolvedValue(["f1", "f2", "text1", "post1"])
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "f1", channelName: "Forum 1", type: "forum" }),
      row({ channelId: "f2", channelName: "Muted forum", type: "forum" }),
      row({ channelId: "text1", channelName: "Text", type: "text" }),
      row({ channelId: "post1", channelName: "Post", type: "thread", parentChannelId: "f1" }),
    ])
    mockGetSettings.mockResolvedValue([{ serverId: null, channelId: "f2", level: "nothing" }])

    await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))

    expect(mockListUnreadChannels).toHaveBeenCalledWith(expect.anything(), "u1", ["f1", "f2", "text1", "post1"])
    expect(mockListUnreadForumOpeners).toHaveBeenCalledWith(expect.anything(), "u1", ["f1"])
  })

  it("renders every unread opener as a separately titled child row, newest first", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "f1", channelName: "Forum", type: "forum", lastMessageAt: "2026-06-25T11:00:00Z" }),
    ])
    mockListUnreadForumOpeners.mockResolvedValue([
      opener({ openerMessageId: "m2", childChannelId: "p2", title: "Second full opener", createdAt: "2026-06-25T11:00:00Z", openerSeq: 2 }),
      opener({ openerMessageId: "m1", childChannelId: "p1", title: "First full opener", createdAt: "2026-06-25T10:00:00Z", openerSeq: 1 }),
    ])

    const body = await (await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))).json()
    const children = body.servers[0].channels[0].children
    expect(children.map((child: { channelId: string; channelName: string; openerMessageId: string }) => ({
      channelId: child.channelId,
      title: child.channelName,
      openerMessageId: child.openerMessageId,
    }))).toEqual([
      { channelId: "p2", title: "Second full opener", openerMessageId: "m2" },
      { channelId: "p1", title: "First full opener", openerMessageId: "m1" },
    ])
  })

  it("dedupes an unread opener and child replies by childChannelId while retaining the parent target", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "f1", channelName: "Forum", type: "forum", lastMessageAt: "2026-06-25T10:00:00Z" }),
      row({ channelId: "p1", channelName: "Derived title", type: "thread", parentChannelId: "f1", lastMessageAt: "2026-06-25T12:00:00Z" }),
    ])
    mockListUnreadForumOpeners.mockResolvedValue([
      opener({ title: "Canonical opener title", createdAt: "2026-06-25T10:00:00Z", openerSeq: 7 }),
    ])
    mockListUnreadMentions.mockResolvedValue([
      { message: { channelId: "p1" } },
      { message: { channelId: "p1" } },
    ])

    const body = await (await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))).json()
    const children = body.servers[0].channels[0].children
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      channelId: "p1",
      channelName: "Canonical opener title",
      openerMessageId: "m1",
      lastMessageAt: "2026-06-25T12:00:00Z",
      mentionCount: 2,
    })
  })

  it("drops opener rows whose child channel is individually muted", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "f1", channelName: "Forum", type: "forum" }),
    ])
    mockListUnreadForumOpeners.mockResolvedValue([opener()])
    mockGetSettings.mockResolvedValue([{ serverId: null, channelId: "p1", level: "nothing" }])

    const body = await (await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads"))).json()
    expect(body.servers[0].channels[0].children).toEqual([])
  })

  it("uses opener seq/id as deterministic tie-breaks before child cap truncation", async () => {
    mockListUnreadChannels.mockResolvedValue([
      row({ channelId: "f1", channelName: "Forum", type: "forum" }),
    ])
    mockListUnreadForumOpeners.mockResolvedValue([
      opener({ openerMessageId: "m1", childChannelId: "p1", openerSeq: 1 }),
      opener({ openerMessageId: "m3", childChannelId: "p3", openerSeq: 3 }),
      opener({ openerMessageId: "m2", childChannelId: "p2", openerSeq: 2 }),
    ])

    const body = await (await GET(new NextRequest("http://localhost/api/community/users/me/inbox/unreads?limit=3"))).json()
    expect(body.truncated).toBe(true)
    // Parent consumes one row; the two newest equal-time openers consume the
    // remaining rows in stable seq order.
    expect(body.servers[0].channels[0].children.map((child: { channelId: string }) => child.channelId)).toEqual(["p3", "p2"])
  })
})
