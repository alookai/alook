import { resourceBundleFixture } from "@/test/community-resource-fixtures"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/community/attention-resources.server", () => ({ readCommunityResourceBundle: async (_db: unknown, viewerId: string, { profileIds }: { profileIds: string[] }) => resourceBundleFixture({ viewerId, profiles: profileIds.map(id => ({ id, name: id === "u2" ? "Gus" : "Lindsay", discriminator: id === "u2" ? "1337" : "0007", avatar: null, avatarVersion: 0, statusEmoji: id === "u2" ? "🎧" : null, statusText: id === "u2" ? "Vibing" : null })) }) }))

const listFriends = vi.fn()
const getMember = vi.fn()
const getMembersByUserIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        listFriends: (...a: unknown[]) => listFriends(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => getMember(...a),
        getMembersByUserIds: (...a: unknown[]) => getMembersByUserIds(...a),
      },
    },
  }
})

// Human arm delegates through the real communityActorPolicy → withAuth; mock
// withAuth to inject a human ctx (this route's accepted human arm is the
// inheritor of the retired aggregate GET /friends' friends[] projection).
vi.mock("@/lib/middleware/auth", () => ({
  resolveHumanAuth: async () => ({ context: { env: {}, userId: "u1", email: "u@t.com" } }),
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

  it("filters out existing server members and returns totalFriends when excludeServerId is authorized", async () => {
    getMember.mockResolvedValue({ id: "m1", serverId: "srv_1", userId: "u1", role: "member" })
    listFriends.mockResolvedValue([
      { id: "f1", friendUserId: "u2", friendName: "Gus", friendDiscriminator: "1337", friendImage: null, statusEmoji: null, statusText: null },
      { id: "f2", friendUserId: "u3", friendName: "Lindsay", friendDiscriminator: "0007", friendImage: null, statusEmoji: null, statusText: null },
    ])
    getMembersByUserIds.mockResolvedValue([{ id: "m2", serverId: "srv_1", userId: "u2", role: "member" }])

    const filteredReq = new NextRequest("http://localhost/api/community/friends/accepted?excludeServerId=srv_1", {
      headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
    })
    const res = await GET(filteredReq, {} as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.friends).toEqual([{ id: "f2", userId: "u3", sub: "" }])
    expect(body.totalFriends).toBe(2)
    expect(getMembersByUserIds).toHaveBeenCalledWith(expect.anything(), "srv_1", ["u2", "u3"])

    // Non-member of excludeServerId fails closed with 403 before listing friends.
    getMember.mockResolvedValue(null)
    listFriends.mockClear()
    const denied = await GET(filteredReq, {} as never)
    expect(denied.status).toBe(403)
    expect(listFriends).not.toHaveBeenCalled()
  })
})
