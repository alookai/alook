import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockDeleteChannelMemberAndChildParticipants = vi.fn()
const mockGetPrivateChannelAudienceUserIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        deleteChannelMemberAndChildParticipants: (...a: unknown[]) =>
          mockDeleteChannelMemberAndChildParticipants(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))

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

function req() {
  return new NextRequest("http://localhost/api/community/channels/c1/members/u2", { method: "DELETE" })
}
const ctx = { params: { id: "c1", userId: "u2" } } as any

function managerCtx(creatorId = "u1") {
  return {
    channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId },
    role: "member",
    isPrivate: true,
    isChannelMember: true,
    // Caller in these tests is "u1"; creator gate is roster-anchor creator.
    isCreator: creatorId === "u1",
  }
}

describe("DELETE /channels/[id]/members/[userId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockDeleteChannelMemberAndChildParticipants.mockResolvedValue({ id: "cm1" })
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"])
  })

  it("creator/admin removes a member", async () => {
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "u2",
    )
    expect(mockBroadcastToUserSafe).toHaveBeenCalled()
  })

  it("removing a FORUM member cascades: drops their participant rows across posts", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "f1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "u1" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/channels/f1/members/u2", { method: "DELETE" }),
      { params: { id: "f1", userId: "u2" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "f1",
      "u2",
    )
  })

  it("cannot remove the creator (400)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx("u2"))
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/channels/c1/members/u2", { method: "DELETE" }),
      { params: { id: "c1", userId: "u2" } } as any,
    )
    expect(res.status).toBe(400)
    expect(mockDeleteChannelMemberAndChildParticipants).not.toHaveBeenCalled()
  })

  it("rejects a non-creator removing someone else (403)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx("other"),
      isChannelMember: true,
      role: "member",
    })
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(403)
  })

  it("self-leave: a non-creator member may remove themselves (204)", async () => {
    // Caller u1 (not the creator), removing their OWN row u1.
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx("other"), // creator is someone else → isCreator false
      isChannelMember: true,
      role: "member",
    })
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/channels/c1/members/u1", { method: "DELETE" }),
      { params: { id: "c1", userId: "u1" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "u1",
    )
  })

  it("creator can self-leave their own channel after creator handoff (204)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx("u1"))
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/channels/c1/members/u1", { method: "DELETE" }),
      { params: { id: "c1", userId: "u1" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "u1",
    )
  })

  it("bot creator can self-leave its private channel", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx("bot1"),
      isCreator: true,
    })
    const ref = "/Alook#5620/team"
    const res = await DELETE(
      new NextRequest(`http://localhost/x?ref=${encodeURIComponent(ref)}`, {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "bot1",
    )
  })

  it("bot resolves a private channel ref and removes only itself", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx("other"),
      isCreator: false,
    })
    const ref = "/Alook#5620/team"
    const res = await DELETE(
      new NextRequest(`http://localhost/api/community/channels/resolve/members/self?ref=${encodeURIComponent(ref)}`, {
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
    expect(mockDeleteChannelMemberAndChildParticipants).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "bot1",
    )
  })

  it("returns an actionable error for a public top-level channel without mutation", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({ ...managerCtx("other"), isPrivate: false })
    const res = await DELETE(
      new NextRequest("http://localhost/x?ref=%2FAlook%235620%2Fgeneral", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: "public channels cannot be left independently — leave the server instead",
    })
    expect(mockDeleteChannelMemberAndChildParticipants).not.toHaveBeenCalled()
  })

  it("rejects DM refs and raw target user ids before resolution or mutation", async () => {
    const dm = await DELETE(
      new NextRequest("http://localhost/x?ref=%2F.dm%2Falice%230042", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(dm.status).toBe(400)

    const raw = await DELETE(
      new NextRequest("http://localhost/x?ref=%2FAlook%235620%2Fteam", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "u2" } } as any,
    )
    expect(raw.status).toBe(403)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
    expect(mockDeleteChannelMemberAndChildParticipants).not.toHaveBeenCalled()
  })

  it("existence-masks an invalid or cross-server ref", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "server not found" })
    const res = await DELETE(
      new NextRequest("http://localhost/x?ref=%2FOther%230042%2Fteam", {
        method: "DELETE",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve", userId: "self" } } as any,
    )
    expect(res.status).toBe(404)
    expect(mockDeleteChannelMemberAndChildParticipants).not.toHaveBeenCalled()
  })
})
