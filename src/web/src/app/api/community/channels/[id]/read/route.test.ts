import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockMarkChannelReadBuilder = vi.fn()
const mockMarkChannelMentionsReadBuilder = vi.fn()
const mockDismissForYouForChannelBuilder = vi.fn()
const mockBatch = vi.fn()

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({ batch: (...a: unknown[]) => mockBatch(...a) })),
}))

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
        markChannelReadBuilder: (...a: unknown[]) => mockMarkChannelReadBuilder(...a),
      },
      communityMention: {
        markChannelMentionsReadBuilder: (...a: unknown[]) =>
          mockMarkChannelMentionsReadBuilder(...a),
      },
      communityInbox: {
        dismissForYouForChannelBuilder: (...a: unknown[]) =>
          mockDismissForYouForChannelBuilder(...a),
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

function putReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/read", {
    method: "PUT",
  })
}

describe("PUT /api/community/channels/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Each builder returns an opaque token so the route body can pass it to
    // db.batch — the batch call is what we actually assert on.
    mockMarkChannelReadBuilder.mockReturnValue({ __builder: "markChannelRead" })
    mockMarkChannelMentionsReadBuilder.mockReturnValue({
      __builder: "markChannelMentionsRead",
    })
    mockDismissForYouForChannelBuilder.mockReturnValue({
      __builder: "dismissForYouForChannel",
    })
    mockBatch.mockResolvedValue(undefined)
  })

  it("returns 200 and issues a single db.batch with all three builder statements", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)

    // All three builders are invoked (they return statements, no side effects).
    expect(mockMarkChannelReadBuilder).toHaveBeenCalledTimes(1)
    expect(mockMarkChannelMentionsReadBuilder).toHaveBeenCalledTimes(1)
    expect(mockDismissForYouForChannelBuilder).toHaveBeenCalledTimes(1)

    // Exactly one batch call carrying all three statements in order.
    expect(mockBatch).toHaveBeenCalledTimes(1)
    const batchArg = mockBatch.mock.calls[0]![0]
    expect(Array.isArray(batchArg)).toBe(true)
    expect(batchArg).toHaveLength(3)
    expect(batchArg[0]).toEqual({ __builder: "markChannelRead" })
    expect(batchArg[1]).toEqual({ __builder: "markChannelMentionsRead" })
    expect(batchArg[2]).toEqual({ __builder: "dismissForYouForChannel" })
  })

  it("propagates a batch failure so callers see the error (all writes roll back)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    // D1 batches are atomic: if the batch rejects, the whole transaction
    // rolls back. We verify the route surfaces that failure rather than
    // silently returning 200.
    mockBatch.mockRejectedValue(new Error("d1 batch failed"))

    await expect(PUT(putReq(), { params: { id: "c1" } } as any)).rejects.toThrow(
      "d1 batch failed"
    )
    expect(mockBatch).toHaveBeenCalledTimes(1)
  })

  it("returns 400 when the channel id is missing", async () => {
    const res = await PUT(putReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 404 when the channel does not exist", async () => {
    mockGetChannel.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
    expect(mockMarkChannelReadBuilder).not.toHaveBeenCalled()
    expect(mockMarkChannelMentionsReadBuilder).not.toHaveBeenCalled()
    expect(mockDismissForYouForChannelBuilder).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    // requireChannelMember short-circuits to 403 when the member/channel join is empty.
    mockGetChannelForMember.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(403)
    expect(mockMarkChannelReadBuilder).not.toHaveBeenCalled()
    expect(mockMarkChannelMentionsReadBuilder).not.toHaveBeenCalled()
    expect(mockDismissForYouForChannelBuilder).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })
})
