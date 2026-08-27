import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
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
    },
  }
})


vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
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
})
