import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockMarkRead = vi.fn()

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
      communityReadState: {
        markRead: (...a: unknown[]) => mockMarkRead(...a),
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

import { PUT } from "./route"

function putReq(body?: unknown) {
  return new NextRequest("http://localhost/api/community/threads/t1/read", {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  })
}

describe("PUT /api/community/threads/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMarkRead.mockResolvedValue({ ok: true })
  })

  it("returns 200 when the caller is a thread-channel member", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })

    const res = await PUT(putReq({ lastReadMessageId: "m9" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)

    expect(mockMarkRead).toHaveBeenCalledTimes(1)
    const call = mockMarkRead.mock.calls[0][1]
    expect(call.userId).toBe("u1")
    expect(call.channelId).toBe("t1")
    expect(call.lastReadMessageId).toBe("m9")
  })

  it("returns 400 when the id is missing", async () => {
    const res = await PUT(putReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the thread channel does not exist", async () => {
    mockGetChannel.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(403)
    expect(mockMarkRead).not.toHaveBeenCalled()
  })
})
