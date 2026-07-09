import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getMemberships = vi.fn()
const bulkUpdateRailOrder = vi.fn()
const updateRailOrder = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMemberships: (...a: unknown[]) => getMemberships(...a),
        bulkUpdateRailOrder: (...a: unknown[]) => bulkUpdateRailOrder(...a),
        updateRailOrder: (...a: unknown[]) => updateRailOrder(...a),
      },
    },
  }
})

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
  return new NextRequest("http://localhost/api/community/servers/reorder", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("PATCH /api/community/servers/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMemberships.mockResolvedValue([
      { serverId: "s1" },
      { serverId: "s2" },
      { serverId: "s3" },
    ])
    bulkUpdateRailOrder.mockResolvedValue(undefined)
    updateRailOrder.mockResolvedValue(undefined)
  })

  it("batched update on happy path: bulkUpdateRailOrder called exactly once, updateRailOrder not called", async () => {
    const res = await PATCH(patchReq({ serverIds: ["s1", "s2", "s3"] }))
    expect(res.status).toBe(200)
    expect(bulkUpdateRailOrder).toHaveBeenCalledTimes(1)
    expect(bulkUpdateRailOrder).toHaveBeenCalledWith({}, "u1", ["s1", "s2", "s3"])
    expect(updateRailOrder).not.toHaveBeenCalled()
  })

  it("positions applied match input order (third arg preserves order)", async () => {
    await PATCH(patchReq({ serverIds: ["s3", "s1", "s2"] }))
    const third = bulkUpdateRailOrder.mock.calls[0]![2]
    expect(third).toEqual(["s3", "s1", "s2"])
  })

  it("400 when serverIds is empty", async () => {
    const res = await PATCH(patchReq({ serverIds: [] }))
    expect(res.status).toBe(400)
    expect(bulkUpdateRailOrder).not.toHaveBeenCalled()
  })

  it("400 when serverIds contains duplicates", async () => {
    const res = await PATCH(patchReq({ serverIds: ["s1", "s1"] }))
    expect(res.status).toBe(400)
    expect(bulkUpdateRailOrder).not.toHaveBeenCalled()
  })

  it("403 when the caller is not a member of every server", async () => {
    getMemberships.mockResolvedValue([{ serverId: "s1" }]) // missing s2
    const res = await PATCH(patchReq({ serverIds: ["s1", "s2"] }))
    expect(res.status).toBe(403)
    expect(bulkUpdateRailOrder).not.toHaveBeenCalled()
  })
})
