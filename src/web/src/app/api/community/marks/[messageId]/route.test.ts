import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockUnmarkMessage = vi.fn()
const mockIsMessageMarked = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessageMark: {
        unmarkMessage: (...args: unknown[]) => mockUnmarkMessage(...args),
        isMessageMarked: (...args: unknown[]) => mockIsMessageMarked(...args),
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

import { DELETE, GET } from "./route"

const ctx = { params: { messageId: "m1" } }

describe("DELETE /api/community/marks/[messageId]", () => {
  beforeEach(() => vi.clearAllMocks())

  it("unmarks self-scoped to ctx.userId and returns ok", async () => {
    mockUnmarkMessage.mockResolvedValue({ id: "mk1" })
    const res = await DELETE(new NextRequest("http://localhost/api/community/marks/m1", { method: "DELETE" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockUnmarkMessage).toHaveBeenCalledWith({}, { userId: "u1", messageId: "m1" })
  })

  it("returns ok even when nothing was deleted (another user's mark = 0-row no-op)", async () => {
    // unmarkMessage's WHERE is userId=ctx.userId AND messageId, so deleting a
    // mark owned by someone else matches 0 rows — the route still returns ok
    // (idempotent), never touching the other user's private mark.
    mockUnmarkMessage.mockResolvedValue(null)
    const res = await DELETE(new NextRequest("http://localhost/api/community/marks/m1", { method: "DELETE" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("GET /api/community/marks/[messageId]", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns {marked:true} when the current user marked the message", async () => {
    mockIsMessageMarked.mockResolvedValue(true)
    const res = await GET(new NextRequest("http://localhost/api/community/marks/m1"), ctx)
    expect(await res.json()).toEqual({ marked: true })
    // self-scoped: the query is asked "did u1 mark m1", never "did anyone".
    expect(mockIsMessageMarked).toHaveBeenCalledWith({}, "u1", "m1")
  })

  it("returns {marked:false} when the current user has not marked it", async () => {
    mockIsMessageMarked.mockResolvedValue(false)
    const res = await GET(new NextRequest("http://localhost/api/community/marks/m1"), ctx)
    expect(await res.json()).toEqual({ marked: false })
  })
})
