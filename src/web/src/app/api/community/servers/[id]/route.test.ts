import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockUpdateServer = vi.fn()
const mockLogAction = vi.fn()
const mockFanOut = vi.fn()
const mockGetServer = vi.fn()
const mockListServerChannels = vi.fn()
const mockListUnreadChannels = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockFindManyCategories = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    query: { communityCategory: { findMany: (...a: unknown[]) => mockFindManyCategories(...a) } },
  })),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityServer: {
        getServer: (...a: unknown[]) => mockGetServer(...a),
        updateServer: (...a: unknown[]) => mockUpdateServer(...a),
      },
      communityChannel: {
        listServerChannelsForViewer: (...a: unknown[]) => mockListServerChannels(...a),
        listVisibleChannelIdsForUser: (...a: unknown[]) => mockListVisibleChannelIds(...a),
      },
      communityInbox: {
        listUnreadChannels: (...a: unknown[]) => mockListUnreadChannels(...a),
      },
      communityAuditLog: {
        logAction: (...a: unknown[]) => mockLogAction(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
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

import { GET, PATCH } from "./route"

const ctx = { params: { id: "s1" } } as any

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("PATCH /api/community/servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockFanOut.mockResolvedValue(undefined)
    mockLogAction.mockResolvedValue(undefined)
  })

  it("normalizes a spaced rename via slugify before calling updateServer", async () => {
    mockUpdateServer.mockResolvedValue({ id: "s1", name: "My-Home" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateServer).toHaveBeenCalledWith(expect.anything(), "s1", { name: "My-Home" })
  })

  it("returns 400 (and never calls updateServer) when the renamed name is all disallowed characters", async () => {
    const res = await PATCH(patchReq({ name: "///" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is not an admin/owner", async () => {
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "member" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })
})

// ── GET — channel unread projection ──────────────────────────────────────
describe("GET /api/community/servers/[id]", () => {
  const getReq = () => new NextRequest("http://localhost/api/community/servers/s1")

  beforeEach(() => {
    vi.clearAllMocks()
    mockListVisibleChannelIds.mockResolvedValue([])
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "member" })
    mockGetServer.mockResolvedValue({
      id: "s1",
      name: "Server",
      description: "",
      icon: null,
      ownerId: "u_owner",
    })
    mockFindManyCategories.mockResolvedValue([
      { id: "cat_A", serverId: "s1", name: "Category A", position: 0, private: 0 },
    ])
  })

  it("a channel with lastMessageAt > lastReadAt (has read-state row) is returned with unread: true", async () => {
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
    ])
    mockListUnreadChannels.mockResolvedValue([
      { channelId: "ch_1", channelName: "general", serverId: "s1", serverName: "Server", lastMessageAt: "t2", lastReadAt: "t1" },
    ])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: true })
  })

  it("a channel the viewer has already read is returned with unread: false", async () => {
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
    ])
    mockListUnreadChannels.mockResolvedValue([])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: false })
  })

  it("a channel unread since before the viewer's read-state existed (no read-state row, lastMessageAt > joinedAt) is returned with unread: true", async () => {
    // listUnreadChannels already applies isChannelUnread — the route just
    // trusts its output, so a row present in the unread list (regardless of
    // lastReadAt being null) must project unread: true.
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
    ])
    mockListUnreadChannels.mockResolvedValue([
      { channelId: "ch_1", channelName: "general", serverId: "s1", serverName: "Server", lastMessageAt: "t2", lastReadAt: null },
    ])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: true })
  })

  it("a channel with historical messages predating membership is returned with unread: false (no false-positive on first join)", async () => {
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
    ])
    // isChannelUnread already excluded this row upstream — listUnreadChannels
    // never returns it.
    mockListUnreadChannels.mockResolvedValue([])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: false })
  })

  it("an unread channel belonging to a different server is not counted — scoped correctly by serverId", async () => {
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
    ])
    mockListUnreadChannels.mockResolvedValue([
      { channelId: "ch_other", channelName: "other", serverId: "s2", serverName: "Other", lastMessageAt: "t2", lastReadAt: null },
    ])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: false })
  })

  it("projects unread onto both categorized channels and the synthetic __uncategorized__ bucket", async () => {
    mockListServerChannels.mockResolvedValue([
      { id: "ch_1", serverId: "s1", categoryId: "cat_A", name: "general", tags: [] },
      { id: "ch_2", serverId: "s1", categoryId: null, name: "loose", tags: [] },
    ])
    mockListUnreadChannels.mockResolvedValue([
      { channelId: "ch_2", channelName: "loose", serverId: "s1", serverName: "Server", lastMessageAt: "t2", lastReadAt: null },
    ])

    const res = await GET(getReq(), ctx)
    const body = await res.json()
    const uncategorized = body.categories.find((c: { id: string }) => c.id === "__uncategorized__")
    expect(uncategorized.channels[0]).toMatchObject({ id: "ch_2", unread: true })
    expect(body.categories[0].channels[0]).toMatchObject({ id: "ch_1", unread: false })
  })

  it("returns 403 when the caller is not a member", async () => {
    mockGetMember.mockResolvedValue(null)
    mockListServerChannels.mockResolvedValue([])
    mockListUnreadChannels.mockResolvedValue([])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockGetServer).not.toHaveBeenCalled()
  })
})
