import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetReadState = vi.fn()
const mockRequireDMParticipant = vi.fn()

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
      },
    },
  }
})

vi.mock("@/lib/community/permissions", () => ({
  requireDMParticipant: (...a: unknown[]) => mockRequireDMParticipant(...a),
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function getReq() {
  return new NextRequest(
    "http://localhost/api/community/dm/dm1/read-state",
    { method: "GET" },
  )
}

describe("GET /api/community/dm/[id]/read-state", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireDMParticipant.mockResolvedValue({ ok: true })
  })

  it("returns { null, null, 0 } when no read-state row exists (never-opened dm)", async () => {
    mockGetReadState.mockResolvedValue(null)

    const res = await GET(getReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 })
    // Args to getReadState should scope by (userId, dmConversationId).
    expect(mockGetReadState).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      dmConversationId: "dm1",
    })
  })

  it("returns the actual (lastReadMessageId, lastReadAt, lastReadSeq) tuple when a row exists", async () => {
    mockGetReadState.mockResolvedValue({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
      lastReadSeq: 42,
    })

    const res = await GET(getReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
      lastReadSeq: 42,
    })
  })

  it("returns 400 when the dm id is missing", async () => {
    const res = await GET(getReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockRequireDMParticipant).not.toHaveBeenCalled()
    expect(mockGetReadState).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is not a participant", async () => {
    mockRequireDMParticipant.mockResolvedValue({
      ok: false,
      error: "not a participant",
      status: 403,
    })

    const res = await GET(getReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(403)
    expect(mockGetReadState).not.toHaveBeenCalled()
  })
})
