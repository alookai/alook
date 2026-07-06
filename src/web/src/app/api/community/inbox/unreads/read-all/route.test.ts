import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkAllServerChannelsRead = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    communityReadState: {
      markAllServerChannelsRead: (...args: unknown[]) => mockMarkAllServerChannelsRead(...args),
    },
  },
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
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

describe("POST /api/community/inbox/unreads/read-all", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the count of NON-EMPTY channels marked read (invariant: empty channels excluded)", async () => {
    // Post-invariant: count == channels that actually received an aligned
    // write. Empty channels are skipped, so this is <= reachable-channel count.
    mockMarkAllServerChannelsRead.mockResolvedValue(7)
    const res = await POST(new NextRequest("http://localhost/api/community/inbox/unreads/read-all", { method: "POST" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, count: 7 })
    expect(mockMarkAllServerChannelsRead).toHaveBeenCalledWith({}, "u1")
  })

  it("returns count 0 when every channel is empty (nothing to write)", async () => {
    mockMarkAllServerChannelsRead.mockResolvedValue(0)
    const res = await POST(new NextRequest("http://localhost/api/community/inbox/unreads/read-all", { method: "POST" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, count: 0 })
  })
})
