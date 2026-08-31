import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockRemoveMemberAndOwnerBots = vi.fn()
const mockListOwnerBotsInServer = vi.fn()
const mockFanOut = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        removeMemberAndOwnerBots: (...a: unknown[]) => mockRemoveMemberAndOwnerBots(...a),
        listOwnerBotsInServer: (...a: unknown[]) => mockListOwnerBotsInServer(...a),
      },
      communityServer: {
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
      },
    },
  }
})


vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function postReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/leave", {
    method: "POST",
  })
}
const ctx = { params: { id: "s1" } } as any

describe("POST /api/community/servers/[id]/leave", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "member" })
    mockResolveServerByNameForMember.mockResolvedValue([{
      id: "s1",
      name: "Alook",
      discriminator: "5620",
    }])
    mockRemoveMemberAndOwnerBots.mockResolvedValue({ id: "mem_1" })
    mockListOwnerBotsInServer.mockResolvedValue([])
    mockFanOut.mockResolvedValue(undefined)
    mockBroadcastToUserSafe.mockResolvedValue(undefined)
  })

  it("returns 204 after removing the member", async () => {
    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(204)

  })

  it("returns 403 when the user is not a member", async () => {
    mockGetMember.mockResolvedValue(null)

    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockRemoveMemberAndOwnerBots).not.toHaveBeenCalled()
  })

  it("returns 400 when the owner tries to leave", async () => {
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })

    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(400)
    expect(mockRemoveMemberAndOwnerBots).not.toHaveBeenCalled()
  })

  it("bulk-removes owner bots in one call instead of getMember loops", async () => {
    mockListOwnerBotsInServer.mockResolvedValue(["bot_1", "bot_2"])

    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockRemoveMemberAndOwnerBots).toHaveBeenCalledWith(
      expect.anything(),
      "mem_1",
      "s1",
      "u1",
      ["bot_1", "bot_2"],
    )
    expect(mockGetMember).toHaveBeenCalledTimes(1)
  })

  it("bot resolves an exact member-scoped handle and converges on the existing leave path", async () => {
    mockGetMember.mockResolvedValue({ id: "bot-mem", userId: "bot1", role: "member" })
    const res = await POST(
      new NextRequest("http://localhost/api/community/servers/resolve/leave?server=Alook%235620", {
        method: "POST",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve" } } as any,
    )
    expect(res.status).toBe(204)
    expect(mockResolveServerByNameForMember).toHaveBeenCalledWith(
      expect.anything(),
      "bot1",
      "Alook#5620",
    )
    expect(mockRemoveMemberAndOwnerBots).toHaveBeenCalledWith(
      expect.anything(),
      "bot-mem",
      "s1",
      "bot1",
      [],
    )
  })

  it("bot cannot supply a raw server id", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/community/servers/s1/leave", {
        method: "POST",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "s1" } } as any,
    )
    expect(res.status).toBe(403)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
    expect(mockRemoveMemberAndOwnerBots).not.toHaveBeenCalled()
  })

  it("existence-masks a server outside the bot's memberships", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(
      new NextRequest("http://localhost/api/community/servers/resolve/leave?server=Other%230042", {
        method: "POST",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve" } } as any,
    )
    expect(res.status).toBe(404)
    expect(mockGetMember).not.toHaveBeenCalled()
    expect(mockRemoveMemberAndOwnerBots).not.toHaveBeenCalled()
  })

  it("rejects a bot server owner without mutation", async () => {
    mockGetMember.mockResolvedValue({ id: "bot-mem", userId: "bot1", role: "owner" })
    const res = await POST(
      new NextRequest("http://localhost/api/community/servers/resolve/leave?server=Alook%235620", {
        method: "POST",
        headers: { authorization: "Bearer crk_test" },
      }),
      { params: { id: "resolve" } } as any,
    )
    expect(res.status).toBe(400)
    expect(mockRemoveMemberAndOwnerBots).not.toHaveBeenCalled()
  })
})
