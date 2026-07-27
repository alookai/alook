import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetSettings = vi.fn()
const mockSetServerLevel = vi.fn()
const mockSetChannelLevel = vi.fn()
const mockRemoveChannelOverride = vi.fn()
const mockGetMember = vi.fn()
const mockGetChannelForMember = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityNotificationSetting: {
        getSettings: (...a: unknown[]) => mockGetSettings(...a),
        setServerLevel: (...a: unknown[]) => mockSetServerLevel(...a),
        setChannelLevel: (...a: unknown[]) => mockSetChannelLevel(...a),
        removeChannelOverride: (...a: unknown[]) => mockRemoveChannelOverride(...a),
      },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityChannel: { getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a) },
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

import { GET, PUT, DELETE } from "./route"

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/notifications", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}
function delReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/notifications", {
    method: "DELETE",
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockGetSettings.mockReset()
  mockSetServerLevel.mockReset()
  mockSetChannelLevel.mockReset()
  mockRemoveChannelOverride.mockReset()
  mockGetMember.mockReset()
  mockGetChannelForMember.mockReset()
})

describe("GET /api/community/notifications", () => {
  it("returns the caller's settings", async () => {
    const rows = [
      { id: "n1", serverId: "s1", channelId: null, level: "all" },
      { id: "n2", serverId: null, channelId: "post_1", level: "mentions" },
    ]
    mockGetSettings.mockResolvedValueOnce(rows)
    const res = await GET(new NextRequest("http://localhost/api/community/notifications"), {} as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rows)
    expect(mockGetSettings).toHaveBeenCalledWith(expect.anything(), "u1")
  })
})

describe("PUT /api/community/notifications", () => {
  it("sets a server level for a member", async () => {
    mockGetMember.mockResolvedValueOnce({ userId: "u1", role: "member" })
    mockSetServerLevel.mockResolvedValueOnce({ id: "n1", serverId: "s1", level: "nothing" })
    const res = await PUT(putReq({ scope: "server", id: "s1", level: "nothing" }), {} as any)
    expect(res.status).toBe(200)
    expect(mockSetServerLevel).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      serverId: "s1",
      level: "nothing",
    })
  })

  it("sets a channel level for a post (any channelType) via requireChannelMember", async () => {
    mockGetChannelForMember.mockResolvedValueOnce({ id: "post_1", type: "post" })
    mockSetChannelLevel.mockResolvedValueOnce({ id: "n2", channelId: "post_1", level: "mentions" })
    const res = await PUT(putReq({ scope: "channel", id: "post_1", level: "mentions" }), {} as any)
    expect(res.status).toBe(200)
    expect(mockSetChannelLevel).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      channelId: "post_1",
      level: "mentions",
    })
  })

  it("rejects a non-member PUT on a post with 403", async () => {
    mockGetChannelForMember.mockResolvedValueOnce(null)
    const res = await PUT(putReq({ scope: "channel", id: "post_1", level: "mentions" }), {} as any)
    expect(res.status).toBe(403)
    expect(mockSetChannelLevel).not.toHaveBeenCalled()
  })

  it("rejects an invalid level with 400", async () => {
    const res = await PUT(putReq({ scope: "server", id: "s1", level: "bogus" }), {} as any)
    expect(res.status).toBe(400)
    expect(mockSetServerLevel).not.toHaveBeenCalled()
  })

  it("rejects a missing/invalid scope with 400", async () => {
    const res = await PUT(putReq({ scope: "galaxy", id: "s1", level: "all" }), {} as any)
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/community/notifications", () => {
  it("removes a channel override (falls back to parent/server default)", async () => {
    mockGetChannelForMember.mockResolvedValueOnce({ id: "post_1", type: "post" })
    mockRemoveChannelOverride.mockResolvedValueOnce({ id: "n2" })
    const res = await DELETE(delReq({ scope: "channel", id: "post_1" }), {} as any)
    expect(res.status).toBe(204)
    expect(mockRemoveChannelOverride).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      channelId: "post_1",
    })
  })

  it("rejects a server-scope DELETE with 400", async () => {
    const res = await DELETE(delReq({ scope: "server", id: "s1" }), {} as any)
    expect(res.status).toBe(400)
    expect(mockRemoveChannelOverride).not.toHaveBeenCalled()
  })
})
