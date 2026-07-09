import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
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
  return new NextRequest("http://localhost/api/community/threads/t1", { method: "GET" })
}

describe("GET /api/community/threads/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the channel row when the caller is a member", async () => {
    const channel = { id: "t1", serverId: "s1", parentChannelId: "c-parent" }
    mockGetChannel.mockResolvedValue(channel)
    mockGetChannelForMember.mockResolvedValue(channel)

    const res = await GET(getReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(channel)
  })

  it("returns 400 when the id is missing", async () => {
    const res = await GET(getReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the thread channel does not exist", async () => {
    mockGetChannel.mockResolvedValue(null)

    const res = await GET(getReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue(null)

    const res = await GET(getReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(403)
  })
})
