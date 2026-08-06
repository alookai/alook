import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockUpdateServer = vi.fn()
const mockLogAction = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityServer: {
        updateServer: (...a: unknown[]) => mockUpdateServer(...a),
      },
      communityAuditLog: {
        logAction: (...a: unknown[]) => mockLogAction(...a),
      },
    },
  }
})

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

import { PATCH } from "./route"

const ctx = { params: { id: "s1" } } as any

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("PATCH /api/community/servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockFanOut.mockResolvedValue(undefined)
    mockLogAction.mockResolvedValue(undefined)
  })

  it("normalizes a spaced rename via slugify before calling updateServer", async () => {
    mockUpdateServer.mockResolvedValue({ id: "s1", name: "My-Home" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateServer).toHaveBeenCalledWith(expect.anything(), "s1", { name: "My-Home" })
  })

  it("returns 400 (and never calls updateServer) when the renamed name is all disallowed characters", async () => {
    const res = await PATCH(patchReq({ name: "///" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is not an admin/owner", async () => {
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "member" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })
})
