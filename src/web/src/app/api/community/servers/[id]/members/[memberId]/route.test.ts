import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

// getMember is used by requireServerAdmin to load the *caller*'s row.
// getMemberById is the new scoped helper for the *target* row.
// listMembers must never be called by the routes under test — the whole
// point of #4 is to stop the full-server-roster scan on single-target ops.
const mockGetMember = vi.fn()
const mockGetMemberById = vi.fn()
const mockListMembers = vi.fn()
const mockUpdateRole = vi.fn()
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
        getMemberById: (...a: unknown[]) => mockGetMemberById(...a),
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        updateRole: (...a: unknown[]) => mockUpdateRole(...a),
        removeMember: (...a: unknown[]) => mockRemoveMember(...a),
        listOwnerBotsInServer: vi.fn().mockResolvedValue([]),
      },
      user: {
        getUserInternal: vi.fn().mockResolvedValue({
          id: "u_target",
          isBot: false,
          ownerUserId: null,
          deletedAt: null,
        }),
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
    return handler(req, { env: { DB: {} }, userId: "u_admin", email: "admin@t.com", params })
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

import { PATCH, DELETE } from "./route"

const ctx = { params: { id: "srv_1", memberId: "mem_target" } } as any

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/srv_1/members/mem_target", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

function deleteReq() {
  return new NextRequest("http://localhost/api/community/servers/srv_1/members/mem_target", {
    method: "DELETE",
  })
}

describe("PATCH /api/community/servers/[id]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Caller is an admin.
    mockGetMember.mockResolvedValue({
      id: "mem_admin",
      serverId: "srv_1",
      userId: "u_admin",
      role: "admin",
    })
    // Target is a plain member.
    mockGetMemberById.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_target",
      role: "member",
      userName: "Target User",
      userEmail: "t@x.com",
      userImage: null,
    })
    mockUpdateRole.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_target",
      role: "admin",
    })
    mockFanOut.mockResolvedValue(undefined)
  })

  it("succeeds and calls getMemberById exactly once, listMembers zero times", async () => {
    const res = await PATCH(patchReq({ role: "admin" }), ctx)
    expect(res.status).toBe(200)

    expect(mockGetMemberById).toHaveBeenCalledTimes(1)
    expect(mockGetMemberById).toHaveBeenCalledWith(expect.anything(), "mem_target", { serverId: "srv_1" })
    // The whole point of #4: no full-server roster scan for a single-target op.
    expect(mockListMembers).not.toHaveBeenCalled()

    expect(mockUpdateRole).toHaveBeenCalledWith(expect.anything(), "mem_target", "admin")
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockFanOut).toHaveBeenCalledTimes(1)
  })

  it("returns 404 when the target member is not scoped to this server (getMemberById returns null)", async () => {
    mockGetMemberById.mockResolvedValue(null)
    const res = await PATCH(patchReq({ role: "admin" }), ctx)
    expect(res.status).toBe(404)
    expect(mockUpdateRole).not.toHaveBeenCalled()
    expect(mockListMembers).not.toHaveBeenCalled()
  })

  it("returns 403 when a non-owner tries to change the owner's role", async () => {
    mockGetMemberById.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_owner",
      role: "owner",
      userName: "Owner",
      userEmail: "o@x.com",
      userImage: null,
    })
    const res = await PATCH(patchReq({ role: "admin" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateRole).not.toHaveBeenCalled()
  })

  it("returns 400 when caller tries to change their own role (self-guard fires before getMemberById)", async () => {
    // Caller row: same id as the target param
    mockGetMember.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_admin",
      role: "admin",
    })
    const res = await PATCH(patchReq({ role: "member" }), ctx)
    expect(res.status).toBe(400)
    expect(mockGetMemberById).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/community/servers/[id]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({
      id: "mem_admin",
      serverId: "srv_1",
      userId: "u_admin",
      role: "admin",
    })
    mockGetMemberById.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_target",
      role: "member",
      userName: "Target User",
      userEmail: "t@x.com",
      userImage: null,
    })
    mockRemoveMember.mockResolvedValue({ id: "mem_target" })
    mockFanOut.mockResolvedValue(undefined)
  })

  it("succeeds and calls getMemberById exactly once, listMembers zero times", async () => {
    const res = await DELETE(deleteReq(), ctx)
    expect(res.status).toBe(204)

    expect(mockGetMemberById).toHaveBeenCalledTimes(1)
    expect(mockGetMemberById).toHaveBeenCalledWith(expect.anything(), "mem_target", { serverId: "srv_1" })
    expect(mockListMembers).not.toHaveBeenCalled()

    expect(mockRemoveMember).toHaveBeenCalledWith(expect.anything(), "mem_target")
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    // Broadcast payload uses target.userId — proves the scoped helper's row
    // is what the fan-out reads.
    expect(mockFanOut).toHaveBeenCalledWith("srv_1", expect.objectContaining({ userId: "u_target" }))
  })

  it("returns 404 when the target member is not scoped to this server", async () => {
    mockGetMemberById.mockResolvedValue(null)
    const res = await DELETE(deleteReq(), ctx)
    expect(res.status).toBe(404)
    expect(mockRemoveMember).not.toHaveBeenCalled()
    expect(mockListMembers).not.toHaveBeenCalled()
  })

  it("returns 403 when kicking the server owner", async () => {
    mockGetMemberById.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_owner",
      role: "owner",
      userName: "Owner",
      userEmail: "o@x.com",
      userImage: null,
    })
    const res = await DELETE(deleteReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockRemoveMember).not.toHaveBeenCalled()
  })

  it("returns 403 when an admin tries to kick another admin (owner-only)", async () => {
    mockGetMemberById.mockResolvedValue({
      id: "mem_target",
      serverId: "srv_1",
      userId: "u_target_admin",
      role: "admin",
      userName: "Other Admin",
      userEmail: "oa@x.com",
      userImage: null,
    })
    const res = await DELETE(deleteReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockRemoveMember).not.toHaveBeenCalled()
  })
})
