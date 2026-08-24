import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMPeer = vi.fn()
const mockIsBlocked = vi.fn()
const mockGetMessage = vi.fn()
const mockMarkReadToMessageBuilder = vi.fn()
const mockReadStateAdvancesCondition = vi.fn()
const mockAdvanceReadStateRevisionWhenAnyBuilder = vi.fn()
const mockAccountReadStateRevisionBuilder = vi.fn()
const mockUnreadChannelMentionThroughSeqCondition = vi.fn()
const mockMarkChannelMentionsReadBuilder = vi.fn()
const mockBatch = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockGetPrimaryDb = vi.fn(() => ({ batch: (...args: unknown[]) => mockBatch(...args) }))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: (...args: unknown[]) => mockGetPrimaryDb(...args),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...args: unknown[]) => mockGetChannel(...args),
        getChannelForMember: (...args: unknown[]) => mockGetChannelForMember(...args),
      },
      communityDm: {
        getDM: (...args: unknown[]) => mockGetDM(...args),
        getDMPeer: (...args: unknown[]) => mockGetDMPeer(...args),
      },
      communityFriendship: {
        isBlocked: (...args: unknown[]) => mockIsBlocked(...args),
      },
      communityMessage: {
        getMessage: (...args: unknown[]) => mockGetMessage(...args),
      },
      communityReadState: {
        markReadToMessageBuilder: (...args: unknown[]) => mockMarkReadToMessageBuilder(...args),
        readStateAdvancesCondition: (...args: unknown[]) => mockReadStateAdvancesCondition(...args),
        advanceReadStateRevisionWhenAnyBuilder: (...args: unknown[]) =>
          mockAdvanceReadStateRevisionWhenAnyBuilder(...args),
        accountReadStateRevisionBuilder: (...args: unknown[]) =>
          mockAccountReadStateRevisionBuilder(...args),
      },
      communityMention: {
        unreadChannelMentionThroughSeqCondition: (...args: unknown[]) =>
          mockUnreadChannelMentionThroughSeqCondition(...args),
        markChannelMentionsReadBuilder: (...args: unknown[]) =>
          mockMarkChannelMentionsReadBuilder(...args),
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

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mockBroadcastToUserSafe(...args),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { PUT } from "./route"

function putReq(body?: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/read", {
    method: "PUT",
    ...(body !== undefined
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  })
}

function allow(type = "text") {
  mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type })
  mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type })
}

describe("PUT /api/community/channels/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMarkReadToMessageBuilder.mockReturnValue({ __builder: "mark" })
    mockMarkChannelMentionsReadBuilder.mockReturnValue({ __builder: "mentions" })
    mockReadStateAdvancesCondition.mockReturnValue({ __condition: "pointer" })
    mockUnreadChannelMentionThroughSeqCondition.mockReturnValue({ __condition: "mention" })
    mockAdvanceReadStateRevisionWhenAnyBuilder.mockReturnValue({ __builder: "revision" })
    mockAccountReadStateRevisionBuilder.mockReturnValue({ __builder: "current" })
    mockBatch.mockResolvedValue([[{ revision: 7 }], [], [], [{ revision: 7 }]])
    mockBroadcastToUserSafe.mockResolvedValue(undefined)
    mockGetDM.mockResolvedValue({ id: "c1", lastMessageAt: null, createdAt: "t" })
    mockGetDMPeer.mockResolvedValue({ otherUserId: "u2" })
    mockIsBlocked.mockResolvedValue(false)
  })

  it.each(["text", "forum", "thread", "dm"])(
    "uses the same exact-target cursor path for %s channels",
    async (type) => {
      allow(type)
      mockGetMessage.mockResolvedValue({
        id: "m42",
        channelId: "c1",
        createdAt: "2026-08-24T01:02:03.000Z",
        seq: 42,
      })

      const res = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)

      expect(res.status).toBe(200)
      expect(mockGetMessage).toHaveBeenCalledWith(expect.anything(), "m42")
      expect(mockMarkReadToMessageBuilder).toHaveBeenCalledWith(expect.anything(), {
        userId: "u1",
        channelId: "c1",
        message: {
          id: "m42",
          channelId: "c1",
          createdAt: "2026-08-24T01:02:03.000Z",
          seq: 42,
        },
      })
      expect(mockBatch.mock.calls[0]![0]).toEqual([
        { __builder: "revision" },
        { __builder: "mark" },
        { __builder: "mentions" },
        { __builder: "current" },
      ])
      expect(mockBroadcastToUserSafe).toHaveBeenCalledTimes(1)
      await expect(res.json()).resolves.toEqual({ changed: true, targetSeq: 42, revision: 7 })
    },
  )

  it("returns current revision with no frame for an equivalent no-op", async () => {
    allow()
    mockGetMessage.mockResolvedValue({ id: "m42", channelId: "c1", createdAt: "t", seq: 42 })
    mockBatch.mockResolvedValue([[], [], [], [{ revision: 9 }]])

    const res = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)

    await expect(res.json()).resolves.toEqual({ changed: false, targetSeq: 42, revision: 9 })
    expect(mockBroadcastToUserSafe).not.toHaveBeenCalled()
  })

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["malformed", "{"],
    ["object without target", {}],
    ["alternative target key", { targetMessageId: "m42" }],
    ["additional key", { lastReadMessageId: "m42", extra: true }],
    ["empty target", { lastReadMessageId: "" }],
    ["non-string target", { lastReadMessageId: 42 }],
    ["null", null],
    ["array", [{ lastReadMessageId: "m42" }]],
  ])("rejects %s body without reading latest", async (_label, body) => {
    allow()

    const res = await PUT(putReq(body), { params: { id: "c1" } } as any)

    expect(res.status).toBe(400)
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 404 for an unknown target", async () => {
    allow()
    mockGetMessage.mockResolvedValue(null)
    const res = await PUT(putReq({ lastReadMessageId: "missing" }), { params: { id: "c1" } } as any)
    expect(res.status).toBe(404)
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("returns 400 for a target in another channel", async () => {
    allow()
    mockGetMessage.mockResolvedValue({ id: "m42", channelId: "other", createdAt: "t", seq: 42 })
    const res = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)
    expect(res.status).toBe(400)
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("does not disclose an existing target in an inaccessible channel", async () => {
    mockGetChannel
      .mockResolvedValueOnce({ id: "c1", serverId: "s1", type: "text" })
      .mockResolvedValueOnce(null)
    mockGetChannelForMember
      .mockResolvedValueOnce({ id: "c1", serverId: "s1", type: "text" })
    mockGetMessage.mockResolvedValue({ id: "m42", channelId: "private", createdAt: "t", seq: 42 })

    const res = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)

    expect(res.status).toBe(404)
    expect(mockBatch).not.toHaveBeenCalled()
  })

  it("preserves unknown-channel 404 and known-nonmember 403 before target lookup", async () => {
    mockGetChannel.mockResolvedValueOnce(null)
    const missing = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)
    expect(missing.status).toBe(404)

    mockGetChannel.mockResolvedValueOnce({ id: "c1", serverId: "s1", type: "forum" })
    mockGetChannelForMember.mockResolvedValueOnce(null)
    const forbidden = await PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any)
    expect(forbidden.status).toBe(403)
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  it("surfaces an atomic batch failure", async () => {
    allow()
    mockGetMessage.mockResolvedValue({ id: "m42", channelId: "c1", createdAt: "t", seq: 42 })
    mockBatch.mockRejectedValue(new Error("d1 batch failed"))

    await expect(PUT(putReq({ lastReadMessageId: "m42" }), { params: { id: "c1" } } as any))
      .rejects.toThrow("d1 batch failed")
  })
})
