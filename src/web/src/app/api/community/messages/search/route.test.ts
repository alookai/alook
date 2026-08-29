import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockSearchMessagesInServer = vi.fn()
const mockSearchMessages = vi.fn()
const mockRequireServerMember = vi.fn()
const mockRequireChannelMember = vi.fn()
const mockRequireDMAccess = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityChannel: { listVisibleChannelIds: (...a: unknown[]) => mockListVisibleChannelIds(...a) },
      communitySearch: {
        searchMessagesInServer: (...a: unknown[]) => mockSearchMessagesInServer(...a),
        searchMessages: (...a: unknown[]) => mockSearchMessages(...a),
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

vi.mock("@/lib/community/permissions", () => ({
  requireServerMember: (...a: unknown[]) => mockRequireServerMember(...a),
  requireChannelMember: (...a: unknown[]) => mockRequireChannelMember(...a),
  requireDMAccess: (...a: unknown[]) => mockRequireDMAccess(...a),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

describe("GET /api/community/messages/search — server scope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    mockListVisibleChannelIds.mockResolvedValue(["c_pub", "c_priv_mine"])
    mockSearchMessagesInServer.mockResolvedValue([])
    mockSearchMessages.mockResolvedValue([])
    mockRequireServerMember.mockResolvedValue({ ok: true, value: { id: "m1" } })
    mockRequireChannelMember.mockResolvedValue({ ok: true, value: { id: "c1" } })
    mockRequireDMAccess.mockResolvedValue({ ok: true, value: { id: "dm1" } })
  })

  it("scopes the server search to the viewer's visible channel ids", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/community/messages/search?q=hello&serverId=s1"),
      { params: {} } as any,
    )
    expect(res.status).toBe(200)
    // Visibility no longer takes an isAdmin flag — admins get the same
    // member-scoped visibility as everyone (no special private access).
    expect(mockListVisibleChannelIds).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      "u1",
    )
    expect(mockSearchMessagesInServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: "s1", visibleChannelIds: ["c_pub", "c_priv_mine"] }),
    )
  })

  it("admin gets the same member-scoped visibility (no isAdmin flag)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "owner" })
    await GET(
      new NextRequest("http://localhost/api/community/messages/search?q=hello&serverId=s1"),
      { params: {} } as any,
    )
    expect(mockListVisibleChannelIds).toHaveBeenCalledWith(
      expect.anything(), "s1", "u1",
    )
  })

  it("returns only canonical versioned author identity fields", async () => {
    mockSearchMessagesInServer.mockResolvedValue([{
      message: { id: "message-1", content: "hello" },
      author: {
        id: "author-1",
        name: "Alice",
        discriminator: "0001",
        image: "/api/community/users/author-1/avatar",
        avatarVersion: 4,
        avatarObjectKey: "user-avatar/author-1/objects/private-key",
      },
    }])

    const res = await GET(
      new NextRequest("http://localhost/api/community/messages/search?q=hello&serverId=s1"),
      { params: {} } as any,
    )

    expect(await res.json()).toEqual({
      results: [{
        message: { id: "message-1", content: "hello" },
        author: {
          id: "author-1",
          name: "Alice",
          discriminator: "0001",
          image: "/api/community/users/author-1/avatar?v=4",
          avatarVersion: 4,
        },
      }],
    })
  })

  it("projects channel-scoped search results", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/community/messages/search?q=hello&channelId=c1"),
      { params: {} } as any,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
    expect(mockSearchMessages).toHaveBeenCalledWith(
      expect.anything(),
      { query: "hello", channelId: "c1" },
    )
  })

  it("projects DM-scoped search results", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/community/messages/search?q=hello&dmConversationId=dm1"),
      { params: {} } as any,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
    expect(mockSearchMessages).toHaveBeenCalledWith(
      expect.anything(),
      { query: "hello", channelId: "dm1" },
    )
  })
})
