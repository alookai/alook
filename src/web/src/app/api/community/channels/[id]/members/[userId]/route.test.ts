import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockDeleteChannelMember = vi.fn()
const mockGetPrivateChannelAudienceUserIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        deleteChannelMember: (...a: unknown[]) => mockDeleteChannelMember(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
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
    channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId },
    role: "member",
    isPrivate: true,
    isChannelMember: true,
  }
}

describe("DELETE /channels/[id]/members/[userId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockDeleteChannelMember.mockResolvedValue({ id: "cm1" })
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"])
  })

  it("creator/admin removes a member", async () => {
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteChannelMember).toHaveBeenCalledWith(expect.anything(), "c1", "u2")
    expect(mockBroadcastToUserSafe).toHaveBeenCalled()
  })

  it("cannot remove the creator (400)", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/channels/c1/members/u1", { method: "DELETE" }),
      { params: { id: "c1", userId: "u1" } } as any,
    )
    expect(res.status).toBe(400)
    expect(mockDeleteChannelMember).not.toHaveBeenCalled()
  })

  it("rejects a non-manager (403)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx("other"),
      isChannelMember: true,
      role: "member",
    })
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(403)
  })
})
