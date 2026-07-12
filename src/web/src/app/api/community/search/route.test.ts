import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockSearchMessagesInServer = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityChannel: { listVisibleChannelIds: (...a: unknown[]) => mockListVisibleChannelIds(...a) },
      communitySearch: { searchMessagesInServer: (...a: unknown[]) => mockSearchMessagesInServer(...a) },
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

describe("GET /api/community/search — server scope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    mockListVisibleChannelIds.mockResolvedValue(["c_pub", "c_priv_mine"])
    mockSearchMessagesInServer.mockResolvedValue([])
  })

  it("scopes the server search to the viewer's visible channel ids", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/community/search?q=hello&serverId=s1"),
      { params: {} } as any,
    )
    expect(res.status).toBe(200)
    expect(mockListVisibleChannelIds).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      "u1",
      { isAdmin: false },
    )
    expect(mockSearchMessagesInServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: "s1", visibleChannelIds: ["c_pub", "c_priv_mine"] }),
    )
  })

  it("resolves isAdmin from the caller's role", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "owner" })
    await GET(
      new NextRequest("http://localhost/api/community/search?q=hello&serverId=s1"),
      { params: {} } as any,
    )
    expect(mockListVisibleChannelIds).toHaveBeenCalledWith(
      expect.anything(), "s1", "u1", { isAdmin: true },
    )
  })
})
