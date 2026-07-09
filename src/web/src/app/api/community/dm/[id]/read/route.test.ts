import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMessage = vi.fn()
const mockGetLatestMessage = vi.fn()
const mockMarkReadToMessage = vi.fn()
const mockRequireDMParticipant = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getLatestMessage: (...a: unknown[]) => mockGetLatestMessage(...a),
      },
      communityReadState: {
        markReadToMessage: (...a: unknown[]) => mockMarkReadToMessage(...a),
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

import { PUT } from "./route"

function putReq(body?: unknown) {
  return new NextRequest("http://localhost/api/community/dm/dm1/read", {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  })
}

describe("PUT /api/community/dm/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMarkReadToMessage.mockResolvedValue(undefined)
    mockRequireDMParticipant.mockResolvedValue({ ok: true })
  })

  it("body id present: aligns write to the message when it belongs to this dm", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m9",
      dmConversationId: "dm1",
      createdAt: "2026-07-04T09:00:00.000Z",
    })

    const res = await PUT(putReq({ lastReadMessageId: "m9" }), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(200)

    expect(mockGetMessage).toHaveBeenCalledWith(expect.anything(), "m9")
    expect(mockMarkReadToMessage).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      dmConversationId: "dm1",
      message: { id: "m9", createdAt: "2026-07-04T09:00:00.000Z" },
    })
    expect(mockGetLatestMessage).not.toHaveBeenCalled()
  })

  it("body id present but message belongs to another dm → 400, no write", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m9",
      dmConversationId: "dm_other",
      createdAt: "2026-07-04T09:00:00.000Z",
    })

    const res = await PUT(putReq({ lastReadMessageId: "m9" }), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(400)
    expect(mockMarkReadToMessage).not.toHaveBeenCalled()
  })

  it("body id present but message does not exist → 400, no write", async () => {
    mockGetMessage.mockResolvedValue(null)

    const res = await PUT(putReq({ lastReadMessageId: "m_ghost" }), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(400)
    expect(mockMarkReadToMessage).not.toHaveBeenCalled()
  })

  it("no body: uses latest DM message and aligns write to it", async () => {
    mockGetLatestMessage.mockResolvedValue({
      id: "m_latest",
      createdAt: "2026-07-05T10:00:00.000Z",
    })

    const res = await PUT(putReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(200)
    expect(mockGetLatestMessage).toHaveBeenCalledWith(expect.anything(), { dmConversationId: "dm1" })
    expect(mockMarkReadToMessage).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      dmConversationId: "dm1",
      message: { id: "m_latest", createdAt: "2026-07-05T10:00:00.000Z" },
    })
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  it("no body on EMPTY dm: no write at all, returns 200 { ok: true }", async () => {
    mockGetLatestMessage.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockMarkReadToMessage).not.toHaveBeenCalled()
  })

  it("returns 400 when the dm id is missing", async () => {
    const res = await PUT(putReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockRequireDMParticipant).not.toHaveBeenCalled()
  })

  it("returns permission error when caller is not a participant", async () => {
    mockRequireDMParticipant.mockResolvedValue({ ok: false, error: "not a participant", status: 403 })

    const res = await PUT(putReq(), { params: { id: "dm1" } } as any)
    expect(res.status).toBe(403)
    expect(mockMarkReadToMessage).not.toHaveBeenCalled()
    expect(mockGetLatestMessage).not.toHaveBeenCalled()
  })
})
