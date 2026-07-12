import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockGetCategory = vi.fn()
const mockUpdateCategory = vi.fn()
const mockDeleteCategory = vi.fn()
const mockHasChannels = vi.fn()
const mockFanOut = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityCategory: {
        getCategory: (...a: unknown[]) => mockGetCategory(...a),
        updateCategory: (...a: unknown[]) => mockUpdateCategory(...a),
        deleteCategory: (...a: unknown[]) => mockDeleteCategory(...a),
        hasChannels: (...a: unknown[]) => mockHasChannels(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
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

import { PATCH, DELETE } from "./route"

const ctx = { params: { id: "s1", catId: "cat1" } } as any

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1/categories/cat1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function delReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/categories/cat1", { method: "DELETE" })
}

describe("PATCH /api/community/servers/[id]/categories/[catId] — unique name", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", creatorId: "u1" })
    mockFanOut.mockResolvedValue(undefined)
    mockLogAudit.mockResolvedValue(undefined)
  })

  it("renames a category", async () => {
    mockUpdateCategory.mockResolvedValue({ id: "cat1", name: "GENERAL" })

    const res = await PATCH(patchReq({ name: "General" }), ctx)
    expect(res.status).toBe(200)
    // Category names are stored uppercased (matches the client's optimistic rename).
    expect(mockUpdateCategory).toHaveBeenCalledWith(expect.anything(), "cat1", { name: "GENERAL" })
  })

  it("returns 409 when renaming onto a name already used by another category in the server", async () => {
    mockUpdateCategory.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed: community_category.server_id, community_category.name"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      }),
    )

    const res = await PATCH(patchReq({ name: "General" }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "a category with this name already exists" })
  })

  it("rethrows non-uniqueness errors from updateCategory", async () => {
    mockUpdateCategory.mockRejectedValue(new Error("boom"))
    await expect(PATCH(patchReq({ name: "General" }), ctx)).rejects.toThrow("boom")
  })
})

describe("PATCH /categories/[catId] — permission + immutable privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", private: 0 })
    mockUpdateCategory.mockResolvedValue({ id: "cat1", serverId: "s1", name: "X", private: 0 })
    mockHasChannels.mockResolvedValue(false)
  })

  it("rejects a plain member with 403", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(403)
  })

  it("admin can rename", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateCategory).toHaveBeenCalled()
  })

  it("ignores private (immutable after creation): a private-only body is 'no changes'", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await PATCH(patchReq({ private: true }), ctx)
    expect(res.status).toBe(400) // no name → nothing to change
    expect(mockUpdateCategory).not.toHaveBeenCalled()
  })

  it("renames and drops any private field from the update", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await PATCH(patchReq({ name: "New", private: true }), ctx)
    expect(res.status).toBe(200)
    // Category names are stored uppercased (matches the client's optimistic rename).
    expect(mockUpdateCategory).toHaveBeenCalledWith(expect.anything(), "cat1", { name: "NEW" })
  })
})

describe("DELETE /categories/[catId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", private: 1 })
    mockDeleteCategory.mockResolvedValue({ id: "cat1" })
  })

  it("rejects a plain member with 403", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
  })

  it("blocks delete when the category still has channels (409, no widening)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    mockHasChannels.mockResolvedValue(true)
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(409)
    expect(mockDeleteCategory).not.toHaveBeenCalled()
  })

  it("admin deletes an empty category", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    mockHasChannels.mockResolvedValue(false)
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteCategory).toHaveBeenCalled()
  })
})
