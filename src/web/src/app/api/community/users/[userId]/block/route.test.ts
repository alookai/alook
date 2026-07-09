import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
const block = vi.fn()
const broadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: { getUserPublic: (...a: unknown[]) => getUser(...a) },
      communityFriendship: { block: (...a: unknown[]) => block(...a) },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => broadcastToUser(...a),
}))

import { POST } from "./route"

const req = new NextRequest("http://localhost/api/community/users/u2/block", { method: "POST" })

describe("POST /api/community/users/[userId]/block", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getUser.mockResolvedValue({ id: "u2" })
    broadcastToUser.mockResolvedValue(undefined)
  })

  it("blocks a stranger and emits friend.block (no friend.remove)", async () => {
    block.mockResolvedValue({
      row: { id: "f1", requesterId: "u1", addresseeId: "u2", status: "blocked" },
      removedFriendshipId: null,
    })
    const res = await POST(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(200)
    const types = broadcastToUser.mock.calls.map((c) => (c[1] as { type: string }).type)
    expect(types).toContain("community:friend.block")
    expect(types).not.toContain("community:friend.remove")
    const blockCall = broadcastToUser.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "community:friend.block",
    )
    expect(blockCall).toBeDefined()
    expect(blockCall![0]).toBe("u2")
    expect(blockCall![1]).toEqual({ type: "community:friend.block", userId: "u1" })
  })

  it("blocking an existing friend also broadcasts friend.remove with the prior friendship id", async () => {
    block.mockResolvedValue({
      row: { id: "f2", requesterId: "u1", addresseeId: "u2", status: "blocked" },
      removedFriendshipId: "f_OLD",
    })
    const res = await POST(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(200)
    const removeCall = broadcastToUser.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "community:friend.remove",
    )
    expect(removeCall).toBeDefined()
    expect(removeCall![0]).toBe("u2")
    expect(removeCall![1]).toEqual({
      type: "community:friend.remove",
      friendshipId: "f_OLD",
    })
  })

  it("400 when blocking yourself", async () => {
    const res = await POST(req, { params: { userId: "u1" } } as never)
    expect(res.status).toBe(400)
    expect(block).not.toHaveBeenCalled()
  })

  it("404 when target user does not exist", async () => {
    getUser.mockResolvedValue(null)
    const res = await POST(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(404)
    expect(block).not.toHaveBeenCalled()
  })
})
