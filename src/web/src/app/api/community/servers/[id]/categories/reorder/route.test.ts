import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getMember = vi.fn()
const getCategoriesByIds = vi.fn()
const reorderCategories = vi.fn()
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
      communityMember: { getMember: (...args: unknown[]) => getMember(...args) },
      communityCategory: {
        getCategoriesByIds: (...args: unknown[]) => getCategoriesByIds(...args),
        reorderCategories: (...args: unknown[]) => reorderCategories(...args),
      },
    },
  }
})
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...args: unknown[]) => fanOut(...args),
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

const ctx = { params: { id: "s1" } } as never
function request(categoryIds: string[]) {
  return new NextRequest("http://localhost/api/community/servers/s1/categories/reorder", {
    method: "PATCH",
    body: JSON.stringify({ categoryIds }),
    headers: { "Content-Type": "application/json" },
  })
}

describe("PATCH /api/community/servers/[id]/categories/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMember.mockResolvedValue({ id: "m1", role: "admin" })
    fanOut.mockResolvedValue(undefined)
  })

  it("fans out the exact validated subset after every row updates", async () => {
    getCategoriesByIds.mockResolvedValue([
      { id: "cat2", serverId: "s1" },
      { id: "cat1", serverId: "s1" },
    ])
    reorderCategories.mockResolvedValue([{ id: "cat2" }, { id: "cat1" }])

    const response = await PATCH(request(["cat2", "cat1"]), ctx)

    expect(response.status).toBe(200)
    expect(reorderCategories).toHaveBeenCalledWith({}, "s1", ["cat2", "cat1"])
    expect(fanOut).toHaveBeenCalledWith("s1", expect.objectContaining({
      categories: [{ id: "cat2", position: 0 }, { id: "cat1", position: 1 }],
    }))
  })

  it("returns 409 and emits no WS projection on a concurrent validation miss", async () => {
    getCategoriesByIds.mockResolvedValue([
      { id: "cat2", serverId: "s1" },
      { id: "cat1", serverId: "s1" },
    ])
    reorderCategories.mockResolvedValue([{ id: "cat2" }])

    const response = await PATCH(request(["cat2", "cat1"]), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "category order changed concurrently" })
    expect(fanOut).not.toHaveBeenCalled()
  })

  it("rejects duplicates before reading or writing categories", async () => {
    const response = await PATCH(request(["cat1", "cat1"]), ctx)
    expect(response.status).toBe(400)
    expect(getCategoriesByIds).not.toHaveBeenCalled()
    expect(reorderCategories).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })
})
