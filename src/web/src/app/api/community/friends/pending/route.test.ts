import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const listPending = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        listPending: (...a: unknown[]) => listPending(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  }
})

import { GET } from "./route"

const req = new NextRequest("http://localhost/api/community/friends/pending")

describe("GET /api/community/friends/pending", () => {
  beforeEach(() => vi.clearAllMocks())

  it("threads the requester/addressee userId through — distinct from the friendship row id — so the avatar seed matches other surfaces", async () => {
    listPending.mockResolvedValue([
      { id: "fr_1", userId: "u_person", name: "Ada", image: null, kind: "incoming", needsOwnerApproval: null },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { pending: Array<{ id: string; userId: string }> }
    expect(body.pending[0].id).toBe("fr_1")
    expect(body.pending[0].userId).toBe("u_person")
  })

  it("returns one row shape with no source tag; carries needsOwnerApproval for the UI to branch", async () => {
    listPending.mockResolvedValue([
      { id: "fr_1", userId: "u_person", name: "Ada", image: null, kind: "outgoing", needsOwnerApproval: null },
      { id: "fr_2", userId: "u_bot", name: "HelperBot", image: null, kind: "outgoing", needsOwnerApproval: "u1" },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { pending: Array<{ id: string; userId: string; kind: string; needsOwnerApproval: string | null }> }
    for (const p of body.pending) expect(p).not.toHaveProperty("source")
    const gated = body.pending.find((p) => p.id === "fr_2")!
    expect(gated.needsOwnerApproval).toBe("u1")
  })
})
