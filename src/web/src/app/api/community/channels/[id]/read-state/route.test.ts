import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetReadState = vi.fn()

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function getReq() {
  return new NextRequest(
    "http://localhost/api/community/channels/c1/read-state",
    { method: "GET" },
  )
}

describe("GET /api/community/channels/[id]/read-state", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns { null, null } when no read-state row exists (never-visited channel)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetReadState.mockResolvedValue(null)

    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ lastReadMessageId: null, lastReadAt: null })
    // Args to getReadState should scope by (userId, channelId).
    expect(mockGetReadState).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      channelId: "c1",
    })
  })

  it("returns the actual (lastReadMessageId, lastReadAt) pair when a row exists", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetReadState.mockResolvedValue({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
    })

    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
    })
  })

  it("returns 400 when the channel id is missing", async () => {
    const res = await GET(getReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
  })

  it("returns 404 for an unknown channel", async () => {
    mockGetChannel.mockResolvedValue(null)
    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
    expect(mockGetReadState).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(403)
    expect(mockGetReadState).not.toHaveBeenCalled()
  })
})
