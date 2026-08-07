import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const listFriends = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        listFriends: (...a: unknown[]) => listFriends(...a),
      },
    },
  }
})

// Human arm delegates through the real withCommunityActor → withAuth; mock
// withAuth to inject a human ctx (this route's accepted human arm is the
// inheritor of the retired aggregate GET /friends' friends[] projection).
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

import { GET } from "./route"

const req = new NextRequest("http://localhost/api/community/friends/accepted")

describe("GET /api/community/friends/accepted — human arm (inherits legacy GET /friends friends[])", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("includes statusEmoji/statusText sourced from the joined profile row", async () => {
    listFriends.mockResolvedValue([
      { id: "f1", friendUserId: "u2", friendName: "Gus", friendDiscriminator: "1337", friendImage: null, statusEmoji: "🎧", statusText: "Vibing" },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { friends: Array<{ statusEmoji: string | null; statusText: string }> }
    expect(body.friends[0]).toMatchObject({ statusEmoji: "🎧", statusText: "Vibing" })
  })

  it("defaults statusEmoji/statusText for a friend with no profile row (no crash on the leftJoin)", async () => {
    listFriends.mockResolvedValue([
      { id: "f2", friendUserId: "u3", friendName: "Lindsay", friendDiscriminator: "0007", friendImage: null, statusEmoji: null, statusText: null },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { friends: Array<{ statusEmoji: string | null; statusText: string }> }
    expect(body.friends[0]).toMatchObject({ statusEmoji: null, statusText: "" })
  })
})
