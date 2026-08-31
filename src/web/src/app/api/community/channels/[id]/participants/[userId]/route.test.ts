import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockParseRef = vi.hoisted(() => vi.fn())
const mockDeleteThreadParticipantWithCreatorHandoff = vi.fn()
const mockListThreadParticipantUserIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mockBroadcastToUserSafe(...args),
}))

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  mockParseRef.mockImplementation(actual.parseRef)
  return {
    ...actual,
    parseRef: (...a: Parameters<typeof actual.parseRef>) => mockParseRef(...a),
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        deleteThreadParticipantWithCreatorHandoff: (...a: unknown[]) =>
          mockDeleteThreadParticipantWithCreatorHandoff(...a),
      },
      communityThread: {
        listThreadParticipantUserIds: (...a: unknown[]) => mockListThreadParticipantUserIds(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const bot = req.headers.get("authorization")?.startsWith("Bearer crk_")
    return handler(req, {
      env: { DB: {} },
      actor: bot
        ? { kind: "bot", userId: "bot1", ownerUserId: "u1", machineId: "m1" }
        : { kind: "human", userId: "u1", email: "u@t.com" },
      params,
    })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { DELETE } from "./route"

// Caller is "u1". `channel.creatorId` is the THREAD's own creator (the gate for
// removing others); `anchor.creatorId` is the parent channel's creator, which
// `isCreator` reflects — deliberately DIFFERENT here so a regression to the old
// `access.value.isCreator` gate is caught.
function threadCtx(over: Record<string, unknown> = {}) {
  return {
    channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "parent-owner" },
    role: "member", isPrivate: true, isChannelMember: true, isCreator: false,
    ...over,
  }
}
function delReq() {
  return new NextRequest("http://localhost/x", { method: "DELETE" })
}

describe("DELETE /channels/[id]/participants/[userId] — leave", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx())
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "t1" })
    mockDeleteThreadParticipantWithCreatorHandoff.mockResolvedValue({ id: "tp1" })
    mockListThreadParticipantUserIds.mockResolvedValue(["u2", "u3"])
  })

  it("thread creator leaves after creator handoff and removes their own row", async () => {
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u1" } } as any)
    expect(res.status).toBe(204)
    expect(mockDeleteThreadParticipantWithCreatorHandoff).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      "u1",
    )
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", {
      type: "community:channel.member_remove",
      serverId: "s1",
      channelId: "t1",
      userId: "u1",
    })
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u3", expect.objectContaining({
      type: "community:channel.member_remove",
      userId: "u1",
    }))
  })

  it("thread creator can remove another participant", async () => {
    // channel.creatorId === "u1" (caller) even though anchor/isCreator differ.
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u2" } } as any)
    expect(res.status).toBe(204)
  })

  it("a non-thread-creator cannot remove someone else (403), even the parent-channel creator", async () => {
    // Parent-channel creator (isCreator true) but NOT the thread's creator.
    mockResolveChannelAccessContext.mockResolvedValue(
      threadCtx({
        channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "someone-else" },
        isCreator: true,
      }),
    )
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u2" } } as any)
    expect(res.status).toBe(403)
    expect(mockDeleteThreadParticipantWithCreatorHandoff).not.toHaveBeenCalled()
  })

  it("bot resolves a thread-root ref and removes only its own notify row", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({
      channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "other" },
    }))
    const ref = "/Alook#5620/general/#42"
    const res = await DELETE(
      new NextRequest(`http://localhost/x?ref=${encodeURIComponent(ref)}`, {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockResolveTargetForMember).toHaveBeenCalledWith(
      expect.anything(),
      "bot1",
      ref,
      expect.objectContaining({ createDmIfMissing: false, createThreadIfMissing: false }),
    )
    expect(mockDeleteThreadParticipantWithCreatorHandoff).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      "bot1",
    )
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("bot1", expect.objectContaining({
      type: "community:channel.member_remove",
      userId: "bot1",
    }))
  })

  it("rejects raw target ids and existence-masks cross-server refs", async () => {
    const raw = await DELETE(
      new NextRequest("http://localhost/x?ref=%2FAlook%235620%2Fgeneral%2F%2342", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "u2" } } as any,
    )
    expect(raw.status).toBe(403)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()

    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "server not found" })
    const hidden = await DELETE(
      new NextRequest("http://localhost/x?ref=%2FOther%230042%2Fgeneral%2F%2342", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(hidden.status).toBe(404)
    expect(mockDeleteThreadParticipantWithCreatorHandoff).not.toHaveBeenCalled()
  })

  it("rejects DM refs without mutation", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/x?ref=%2F.dm%2Falice%230042", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
    expect(mockDeleteThreadParticipantWithCreatorHandoff).not.toHaveBeenCalled()
  })

  it("continues through the resolver when ref parsing throws", async () => {
    mockParseRef.mockImplementationOnce(() => {
      throw new Error("parse failure")
    })
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "thread not found" })
    const res = await DELETE(
      new NextRequest("http://localhost/x?ref=malformed", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(404)
    expect(mockResolveTargetForMember).toHaveBeenCalledWith(
      expect.anything(),
      "bot1",
      "malformed",
      expect.objectContaining({ createDmIfMissing: false, createThreadIfMissing: false }),
    )
    expect(mockDeleteThreadParticipantWithCreatorHandoff).not.toHaveBeenCalled()
  })
})
