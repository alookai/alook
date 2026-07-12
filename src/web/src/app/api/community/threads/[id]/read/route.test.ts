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

// The route now fires read-watermark + mention-clear in one `db.batch([...])`
// (mirrors the channel read route). The builders return opaque statement
// markers the batch collects; assert on the builder args, not the statements.
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ batch: (...a: unknown[]) => mockBatch(...a) })) }))

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
        markChannelMentionsReadBuilder: (...a: unknown[]) => mockMarkChannelMentionsReadBuilder(...a),
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
    mockMarkReadToMessageBuilder.mockReturnValue({ __stmt: "read" })
    mockMarkChannelMentionsReadBuilder.mockReturnValue({ __stmt: "mentions" })
    mockBatch.mockResolvedValue(undefined)
  })

  it("body id present: fetches message, scope-checks, batches read + mention-clear to (msg.id, msg.createdAt)", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetMessage.mockResolvedValue({
      id: "m9",
      channelId: "t1",
      createdAt: "2026-07-04T09:00:00.000Z",
    })

    const res = await PUT(putReq({ lastReadMessageId: "m9" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)

    expect(mockGetMessage).toHaveBeenCalledWith(expect.anything(), "m9")
    expect(mockMarkReadToMessageBuilder).toHaveBeenCalledTimes(1)
    expect(mockMarkReadToMessageBuilder.mock.calls[0][1]).toEqual({
      userId: "u1",
      channelId: "t1",
      message: { id: "m9", createdAt: "2026-07-04T09:00:00.000Z" },
    })
    // The thread's own mentions are cleared in the same batch (plan gap #4).
    expect(mockMarkChannelMentionsReadBuilder).toHaveBeenCalledWith(expect.anything(), "u1", "t1")
    expect(mockBatch).toHaveBeenCalledTimes(1)
    expect(mockBatch.mock.calls[0][0]).toEqual([{ __stmt: "read" }, { __stmt: "mentions" }])
    expect(mockGetLatestMessage).not.toHaveBeenCalled()
  })

  it("body id present but message belongs to another channel → 400, no write", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetMessage.mockResolvedValue({
      id: "m9",
      channelId: "t_other",
      createdAt: "2026-07-04T09:00:00.000Z",
    })

    const res = await PUT(putReq({ lastReadMessageId: "m9" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(400)
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("body id present but message does not exist → 404, no write", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetMessage.mockResolvedValue(null)

    const res = await PUT(putReq({ lastReadMessageId: "m_ghost" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(404)
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("no body: uses latest message and aligns write to it", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetLatestMessage.mockResolvedValue({
      id: "m_latest",
      createdAt: "2026-07-05T10:00:00.000Z",
    })

    const res = await PUT(putReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)
    expect(mockGetLatestMessage).toHaveBeenCalledWith(expect.anything(), { channelId: "t1" })
    expect(mockMarkReadToMessageBuilder).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      channelId: "t1",
      message: { id: "m_latest", createdAt: "2026-07-05T10:00:00.000Z" },
    })
    expect(mockBatch).toHaveBeenCalledTimes(1)
    // Body path never consults getMessage.
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  it("no body on EMPTY thread: no write at all, returns 200 { ok: true }", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetLatestMessage.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockBatch).not.toHaveBeenCalled()
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
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "t1", serverId: "s1" })
    mockGetChannelForMember.mockResolvedValue(null)

    const res = await PUT(putReq(), { params: { id: "t1" } } as any)
    expect(res.status).toBe(403)
    expect(mockBatch).not.toHaveBeenCalled()
  })
})
