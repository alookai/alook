import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetMessage = vi.fn()
const mockGetLatestMessage = vi.fn()
const mockMarkReadToMessageBuilder = vi.fn()
const mockMarkChannelMentionsReadBuilder = vi.fn()
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
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getLatestMessage: (...a: unknown[]) => mockGetLatestMessage(...a),
      },
      communityReadState: {
        markReadToMessageBuilder: (...a: unknown[]) => mockMarkReadToMessageBuilder(...a),
      },
      communityMention: {
        markChannelMentionsReadBuilder: (...a: unknown[]) =>
          mockMarkChannelMentionsReadBuilder(...a),
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
  return new NextRequest("http://localhost/api/community/channels/c1/read", {
    method: "PUT",
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  })
}

describe("PUT /api/community/channels/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Each builder returns an opaque token so the route body can pass it to
    // db.batch — the batch call is what we actually assert on.
    mockMarkReadToMessageBuilder.mockReturnValue({ __builder: "markReadToMessage" })
    mockMarkChannelMentionsReadBuilder.mockReturnValue({
      __builder: "markChannelMentionsRead",
    })
    mockBatch.mockResolvedValue(undefined)
  })

  it("no-body call on non-empty channel: uses latest message and issues one batch with both builders", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetLatestMessage.mockResolvedValue({
      id: "m_latest",
      createdAt: "2026-07-05T10:00:00.000Z",
    })

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)

    // Builder invoked with the latest message tuple — that's the invariant.
    expect(mockMarkReadToMessageBuilder).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      channelId: "c1",
      message: { id: "m_latest", createdAt: "2026-07-05T10:00:00.000Z" },
    })

    // Exactly one batch call carrying both statements in order.
    expect(mockBatch).toHaveBeenCalledTimes(1)
    const batchArg = mockBatch.mock.calls[0]![0]
    expect(Array.isArray(batchArg)).toBe(true)
    expect(batchArg).toHaveLength(2)
    expect(batchArg[0]).toEqual({ __builder: "markReadToMessage" })
    expect(batchArg[1]).toEqual({ __builder: "markChannelMentionsRead" })
  })

  it("no-body call on EMPTY channel: no writes at all, returns 200 { ok: true }", async () => {
    // This is the invariant's most load-bearing consequence: mass mark-read
    // on an empty channel writes nothing rather than inserting a
    // lastReadMessageId=null row.
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetLatestMessage.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(mockMarkReadToMessageBuilder).not.toHaveBeenCalled()
    expect(mockMarkChannelMentionsReadBuilder).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("propagates a batch failure so callers see the error (all writes roll back)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetLatestMessage.mockResolvedValue({
      id: "m_latest",
      createdAt: "2026-07-05T10:00:00.000Z",
    })
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
    expect(mockMarkReadToMessageBuilder).not.toHaveBeenCalled()
    expect(mockMarkChannelMentionsReadBuilder).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    // requireChannelMember short-circuits to 403 when the member/channel join is empty.
    mockGetChannelForMember.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(403)
    expect(mockMarkReadToMessageBuilder).not.toHaveBeenCalled()
    expect(mockMarkChannelMentionsReadBuilder).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  // ── #3: PUT body carries `lastReadMessageId` ─────────────────────────────────
  describe("PUT with { lastReadMessageId } body — progressive watermark", () => {
    it("writes the message's createdAt/id via markReadToMessageBuilder when the message belongs to the channel", async () => {
      mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetMessage.mockResolvedValue({
        id: "m_42",
        channelId: "c1",
        createdAt: "2026-07-01T12:00:00.000Z",
      })

      const res = await PUT(putReq({ lastReadMessageId: "m_42" }), { params: { id: "c1" } } as any)
      expect(res.status).toBe(200)
      expect(mockGetMessage).toHaveBeenCalledWith(expect.anything(), "m_42")
      // The builder must receive the message's own timestamp + id — that's
      // the whole point of the progressive watermark.
      expect(mockMarkReadToMessageBuilder).toHaveBeenCalledWith(expect.anything(), {
        userId: "u1",
        channelId: "c1",
        message: { id: "m_42", createdAt: "2026-07-01T12:00:00.000Z" },
      })
      // Body path never consults getLatestMessage.
      expect(mockGetLatestMessage).not.toHaveBeenCalled()
    })

    it("rejects with 400 when the message belongs to a different channel", async () => {
      mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
      // Scope-violation: the message is real but lives in c_other.
      mockGetMessage.mockResolvedValue({
        id: "m_42",
        channelId: "c_other",
        createdAt: "2026-07-01T12:00:00.000Z",
      })

      const res = await PUT(putReq({ lastReadMessageId: "m_42" }), { params: { id: "c1" } } as any)
      expect(res.status).toBe(400)
      expect(mockMarkReadToMessageBuilder).not.toHaveBeenCalled()
      expect(mockBatch).not.toHaveBeenCalled()
    })

    it("returns 404 when the message id doesn't exist at all", async () => {
      mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetMessage.mockResolvedValue(null)

      const res = await PUT(putReq({ lastReadMessageId: "m_ghost" }), { params: { id: "c1" } } as any)
      expect(res.status).toBe(404)
      expect(mockMarkReadToMessageBuilder).not.toHaveBeenCalled()
      expect(mockBatch).not.toHaveBeenCalled()
    })

    it("empty body falls back to latest-message no-body path", async () => {
      mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
      mockGetLatestMessage.mockResolvedValue({
        id: "m_latest",
        createdAt: "2026-07-05T10:00:00.000Z",
      })

      // Empty string body — treated as no lastReadMessageId.
      const res = await PUT(putReq(""), { params: { id: "c1" } } as any)
      expect(res.status).toBe(200)
      // getMessage never fetched because there's no id to check.
      expect(mockGetMessage).not.toHaveBeenCalled()
      // Builder aligned to the LATEST message, not "now".
      expect(mockMarkReadToMessageBuilder).toHaveBeenCalledWith(expect.anything(), {
        userId: "u1",
        channelId: "c1",
        message: { id: "m_latest", createdAt: "2026-07-05T10:00:00.000Z" },
      })
    })
  })
})
