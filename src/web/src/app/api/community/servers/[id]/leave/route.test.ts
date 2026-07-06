import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockRemoveMember = vi.fn()
const mockLogAudit = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        removeMember: (...a: unknown[]) => mockRemoveMember(...a),
        listOwnerBotsInServer: vi.fn().mockResolvedValue([]),
      },
    },
  }
})

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
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
    mockRemoveMember.mockResolvedValue(true)
    mockFanOut.mockResolvedValue(undefined)
  })

  it("returns 204 and audits member_leave with the target member's id", async () => {
    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(204)

    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), {
      serverId: "s1",
      actorId: "u1",
      action: "member_leave",
      targetType: "member",
      targetId: "mem_1",
    })
  })

  it("returns 403 when the user is not a member (and does not audit)", async () => {
    mockGetMember.mockResolvedValue(null)

    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockLogAudit).not.toHaveBeenCalled()
    expect(mockRemoveMember).not.toHaveBeenCalled()
  })

  it("returns 400 when the owner tries to leave (and does not audit)", async () => {
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })

    const res = await POST(postReq(), ctx)
    expect(res.status).toBe(400)
    expect(mockLogAudit).not.toHaveBeenCalled()
    expect(mockRemoveMember).not.toHaveBeenCalled()
  })
})
