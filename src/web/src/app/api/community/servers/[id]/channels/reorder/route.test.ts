import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getMember = vi.fn()
const getChannelsByIds = vi.fn()
const reorderChannels = vi.fn()
const fanOut = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => getMember(...a) },
      communityChannel: {
        getChannelsByIds: (...a: unknown[]) => getChannelsByIds(...a),
        reorderChannels: (...a: unknown[]) => reorderChannels(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => fanOut(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { PATCH } from "./route"

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1/channels/reorder", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const ctx = { params: { id: "s1" } } as never

describe("PATCH /api/community/servers/[id]/channels/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMember.mockResolvedValue({ id: "m1", role: "admin" })
    fanOut.mockResolvedValue(undefined)
    reorderChannels.mockResolvedValue(undefined)
  })

  it("403 when the caller is not an admin", async () => {
    getMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await PATCH(patchReq({ channelIds: ["c1", "c2"] }), ctx)
    expect(res.status).toBe(403)
    expect(reorderChannels).not.toHaveBeenCalled()
  })

  it("400 when channelIds is empty", async () => {
    const res = await PATCH(patchReq({ channelIds: [] }), ctx)
    expect(res.status).toBe(400)
  })

  it("400 when channelIds contains duplicates", async () => {
    const res = await PATCH(patchReq({ channelIds: ["c1", "c1"] }), ctx)
    expect(res.status).toBe(400)
    expect(reorderChannels).not.toHaveBeenCalled()
  })

  it("404 when one channel does not exist", async () => {
    getChannelsByIds.mockResolvedValue([{ id: "c1", serverId: "s1" }]) // missing c2
    const res = await PATCH(patchReq({ channelIds: ["c1", "c2"] }), ctx)
    expect(res.status).toBe(404)
    expect(reorderChannels).not.toHaveBeenCalled()
  })

  it("400 when a channel belongs to a DIFFERENT server (cross-server IDOR)", async () => {
    getChannelsByIds.mockResolvedValue([
      { id: "c1", serverId: "s1" },
      { id: "c2", serverId: "s_OTHER" }, // attacker-supplied foreign id
    ])
    const res = await PATCH(patchReq({ channelIds: ["c1", "c2"] }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "channel does not belong to this server" })
    expect(reorderChannels).not.toHaveBeenCalled()
  })

  it("succeeds when every channel belongs to the target server", async () => {
    getChannelsByIds.mockResolvedValue([
      { id: "c1", serverId: "s1" },
      { id: "c2", serverId: "s1" },
    ])
    const res = await PATCH(patchReq({ channelIds: ["c1", "c2"] }), ctx)
    expect(res.status).toBe(200)
    expect(reorderChannels).toHaveBeenCalledWith({}, "s1", ["c1", "c2"])
    expect(fanOut).toHaveBeenCalled()
  })
})
