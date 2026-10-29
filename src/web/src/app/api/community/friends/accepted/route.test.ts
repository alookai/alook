import { resourceBundleFixture } from "@/test/community-resource-fixtures"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/community/attention-resources.server", () => ({ readCommunityResourceBundle: async (_db: unknown, viewerId: string, { profileIds }: { profileIds: string[] }) => resourceBundleFixture({ viewerId, profiles: profileIds.map(id => ({ id, name: id === "u2" ? "Gus" : "Lindsay", discriminator: id === "u2" ? "1337" : "0007", avatar: null, avatarVersion: 0, statusEmoji: id === "u2" ? "🎧" : null, statusText: id === "u2" ? "Vibing" : null })) }) }))

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

const req = new NextRequest("http://localhost/api/community/friends/accepted", { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })

describe("GET /api/community/friends/accepted — current human relationship/profile contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("publishes statusEmoji/statusText only in the full profile resource", async () => {
    listFriends.mockResolvedValue([
      { id: "f1", friendUserId: "u2", friendName: "Gus", friendDiscriminator: "1337", friendImage: null, statusEmoji: "🎧", statusText: "Vibing" },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.friends[0]).toEqual({ id: "f1", userId: "u2", sub: "" })
    expect(body.resources.profiles[0]).toMatchObject({ id: "u2", statusEmoji: "🎧", statusText: "Vibing" })
  })

  it("keeps nullable status facts in the full profile resource", async () => {
    listFriends.mockResolvedValue([
      { id: "f2", friendUserId: "u3", friendName: "Lindsay", friendDiscriminator: "0007", friendImage: null, statusEmoji: null, statusText: null },
    ])
    const res = await GET(req, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.friends[0]).toEqual({ id: "f2", userId: "u3", sub: "" })
    expect(body.resources.profiles[0]).toMatchObject({ id: "u3", statusEmoji: null, statusText: null })
  })
})
