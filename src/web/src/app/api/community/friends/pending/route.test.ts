import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const listPending = vi.fn()
const listPendingBotRequests = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        listPending: (...a: unknown[]) => listPending(...a),
      },
      communityBot: {
        listPendingFriendRequestsByRequester: (...a: unknown[]) => listPendingBotRequests(...a),
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
    // Regression guard: the pending row's `id` is the friendship row id, not a
    // user id. Seeding <Avatar> off it made the same person render a different
    // shape avatar in the pending list vs. the friends list. The payload must
    // expose `userId` (the joined user.id) for the avatar seed.
    listPending.mockResolvedValue([
      { id: "fr_1", userId: "u_person", name: "Ada", image: null, kind: "incoming" },
    ])
    listPendingBotRequests.mockResolvedValue([])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { pending: Array<{ id: string; userId: string }> }
    expect(body.pending[0].id).toBe("fr_1")
    expect(body.pending[0].userId).toBe("u_person")
  })

  it("merges outgoing bot friend-requests tagged source:'bot' with the approval-request id", async () => {
    listPending.mockResolvedValue([
      { id: "fr_1", userId: "u_person", name: "Ada", image: null, kind: "outgoing" },
    ])
    listPendingBotRequests.mockResolvedValue([
      { id: "bar_1", botUserId: "u_bot", name: "HelperBot", image: null, createdAt: "2026-01-01T00:00:00Z" },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { pending: Array<{ id: string; userId: string; kind: string; source: string }> }
    const human = body.pending.find((p) => p.id === "fr_1")!
    const bot = body.pending.find((p) => p.id === "bar_1")!
    expect(human.source).toBe("friend")
    expect(bot).toMatchObject({ userId: "u_bot", kind: "outgoing", source: "bot" })
  })
})
