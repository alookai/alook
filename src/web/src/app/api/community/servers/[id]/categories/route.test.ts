import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockCreateCategory = vi.fn()
const mockLogAction = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityCategory: {
        createCategory: (...a: unknown[]) => mockCreateCategory(...a),
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

import { POST } from "./route"

const ctx = { params: { id: "s1" } } as any

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1/categories", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/servers/[id]/categories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Category creation is admin/owner-only in the permission model.
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockFanOut.mockResolvedValue(undefined)
    mockLogAction.mockResolvedValue(undefined)
  })

  it("creates a category", async () => {
    mockCreateCategory.mockResolvedValue({ id: "cat1", name: "General", position: 0, private: 0 })

    const res = await POST(postReq({ name: "General" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateCategory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "General" }),
    )
  })

  it("returns 409 when a category with this name already exists in the server", async () => {
    mockCreateCategory.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed: community_category.server_id, community_category.name"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      }),
    )

    const res = await POST(postReq({ name: "General" }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "a category with this name already exists" })
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("rethrows non-uniqueness errors from createCategory", async () => {
    mockCreateCategory.mockRejectedValue(new Error("boom"))
    await expect(POST(postReq({ name: "General" }), ctx)).rejects.toThrow("boom")
  })
})
