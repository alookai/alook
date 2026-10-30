import { act } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityAcceptedFriendsReadSchema, CommunityBlockedFriendsReadSchema, CommunityPendingFriendsReadSchema } from "@alook/shared"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"

const mocks = vi.hoisted(() => ({ accepted: vi.fn(), blocked: vi.fn(), pending: vi.fn(), users: vi.fn(), profiles: vi.fn(), api: vi.fn(), db: {} }))
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }))
vi.mock("@/lib/middleware/community-actor", () => {
  const context = () => ({ actor: { kind: "human", userId: "viewer" }, env: { DB: mocks.db } })
  return {
    withCommunityActor: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => (request: NextRequest) => handler(request, context()),
    communityActorPolicy: () => ({ resolve: async () => ({ context: context() }) }),
    rejectBot: () => null,
  }
})
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("@alook/shared", async original => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries,
    communityFriendship: { ...actual.queries.communityFriendship, listFriends: (...args: unknown[]) => mocks.accepted(...args), listBlocked: (...args: unknown[]) => mocks.blocked(...args), listPending: (...args: unknown[]) => mocks.pending(...args) },
    communityMessage: { ...actual.queries.communityMessage, getMessagesByIdsInChannels: vi.fn(async () => []) },
    communityChannel: { ...actual.queries.communityChannel, listChannelMembershipsForUserInChannels: vi.fn(async () => []) },
    user: { ...actual.queries.user, getUsersByIds: (...args: unknown[]) => mocks.users(...args) },
    communityUserProfile: { ...actual.queries.communityUserProfile, getProfilesByUserIds: (...args: unknown[]) => mocks.profiles(...args), getResourceProfiles: async (db: unknown, ids: string[]) => {
      const users = await mocks.users(db, ids)
      const rows = new Map((await mocks.profiles(db, users.map((row: { id: string }) => row.id))).map((row: { userId: string }) => [row.userId, row]))
      return users.map((row: { id: string; name: string; discriminator: string; image: string | null; avatarVersion: number }) => actual.CommunityResourceProfileSchema.parse({ id: row.id, name: row.name, discriminator: row.discriminator, avatar: actual.canonicalCommunityUserImage(row.id, row.image, row.avatarVersion), avatarVersion: row.avatarVersion,
        ...(rows.has(row.id) ? Object.fromEntries(Object.entries(rows.get(row.id) as object).filter(([key]) => key !== "userId")) : {}) }))
    } },
  } }
})
import { GET as accepted } from "@/app/api/community/friends/accepted/route"
import { GET as blocked } from "@/app/api/community/friends/blocked/route"
import { GET as pending } from "@/app/api/community/friends/pending/route"
import { friendsQueryFn } from "@/hooks/community/use-friends"
const request = (bucket: string) => new NextRequest(`https://alook.test/api/community/friends/${bucket}`, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.accepted.mockResolvedValue([{ id: "accepted-row", friendUserId: "accepted-peer", friendName: "Stale joined hint", friendImage: null, friendAvatarVersion: 0 }])
  mocks.blocked.mockResolvedValue([{ id: "blocked-row", blockedUserId: "blocked-peer", blockedName: "Stale joined hint" }])
  mocks.pending.mockResolvedValue([{ id: "pending-row", userId: "pending-peer", name: "Stale joined hint", kind: "outgoing", needsOwnerApproval: "viewer" }])
  mocks.users.mockImplementation(async (_db, ids: string[]) => ids.map(id => ({ id, name: `Full ${id}`, discriminator: "0042", image: null, avatarVersion: 4 })))
  mocks.profiles.mockImplementation(async (_db, ids: string[]) => ids.map(userId => ({ userId, aboutMe: "About", bannerColor: null, statusEmoji: "🎧", statusText: "Listening" })))
  mocks.api.mockImplementation(async (path: string, options: { authenticationAccount?: string }) => {
    expect(options.authenticationAccount).toBe("viewer")
    const bucket = path.split("/").at(-1)!
    const handler = { accepted, blocked, pending }[bucket as "accepted" | "blocked" | "pending"]
    if (!handler) throw new Error(`Unexpected friend transport ${path}`)
    const response = await handler(request(bucket))
    expect(response.status).toBe(200)
    return JSON.parse(await response.text())
  })
})

describe("real current human friend producers to the query owner", () => {
  it("publishes only resource identity and separate accepted/pending/blocked relation facts", async () => {
    const owner = await createCommunityQueryOwner()
    await act(async () => { await owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn }) })
    expect([...owner.registry.collections.friendships.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "accepted-row", userId: "accepted-peer", kind: "accepted", sub: "" }),
      expect.objectContaining({ id: "pending-row", userId: "pending-peer", kind: "outgoing", needsOwnerApproval: "viewer" }),
      expect.objectContaining({ id: "blocked:blocked-peer", userId: "blocked-peer", kind: "blocked" }),
    ]))
    expect(owner.registry.collections.profiles.get("accepted-peer")).toMatchObject({ name: "Full accepted-peer", avatarVersion: 4, statusEmoji: "🎧", statusText: "Listening" })
    expect(owner.registry.collections.profiles.has("accepted-row")).toBe(false)
    for (const fn of [mocks.accepted, mocks.blocked, mocks.pending]) expect(fn).toHaveBeenCalledExactlyOnceWith(mocks.db, "viewer")
    expect(mocks.users).toHaveBeenCalledWith(mocks.db, ["viewer", "accepted-peer"])
    expect(mocks.api).toHaveBeenCalledTimes(3)
    for (const [bucket, handler, schema] of [["accepted", accepted, CommunityAcceptedFriendsReadSchema], ["blocked", blocked, CommunityBlockedFriendsReadSchema], ["pending", pending, CommunityPendingFriendsReadSchema]] as const) {
      const body = schema.parse(await (await handler(request(bucket))).json())
      const field = bucket === "accepted" ? "friends" : bucket
      for (const row of (body as unknown as Record<string, Array<Record<string, unknown>>>)[field]!) {
        expect(row).not.toHaveProperty("name"); expect(row).not.toHaveProperty("avatar"); expect(row).not.toHaveProperty("avatarVersion")
      }
    }
  })
  it("rejects a missing requested peer resource at the real producer before query publication", async () => {
    mocks.users.mockImplementation(async () => [{ id: "viewer", name: "Viewer", discriminator: "0001", image: null, avatarVersion: 0 }])
    const owner = await createCommunityQueryOwner()
    await expect(owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn, retry: false })).rejects.toThrow()
    expect([...owner.registry.collections.friendships.values()]).toEqual([])
    expect([...owner.registry.collections.profiles.values()]).toEqual([])
  })
  it.each(["accepted", "blocked", "pending"] as const)("preserves a previous good relationship/profile projection on a stale %s producer", async bucket => {
    const owner = await createCommunityQueryOwner()
    await owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn })
    const previous = owner.registry.collections.friendships.get("accepted-row")
    mocks[bucket].mockRejectedValue(new Error("D1_ERROR: database is locked"))
    const handler = { accepted, blocked, pending }[bucket]
    const response = await handler(request(bucket))
    const schema = { accepted: CommunityAcceptedFriendsReadSchema, blocked: CommunityBlockedFriendsReadSchema, pending: CommunityPendingFriendsReadSchema }[bucket]
    expect(schema.parse(await response.json())).toEqual({ contractVersion: BUSINESS_SCHEMA_VERSION, [bucket === "accepted" ? "friends" : bucket]: [], stale: true })
    await expect(owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn, staleTime: 0, retry: false })).rejects.toThrow("stale D1 read")
    expect(owner.registry.collections.friendships.get("accepted-row")).toMatchObject({ id: previous!.id, userId: previous!.userId, kind: "accepted" })
    expect(owner.registry.collections.profiles.get("accepted-peer")?.name).toBe("Full accepted-peer")
  })
  it.each(["accepted", "blocked", "pending"].flatMap(bucket => ["users", "profiles"].map(query => ({ bucket: bucket as "accepted" | "blocked" | "pending", query: query as "users" | "profiles" }))))("returns named stale after $bucket full resource $query BUSY exhaustion", async ({ bucket, query }) => {
    const owner = await createCommunityQueryOwner()
    await owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn })
    mocks[query].mockRejectedValue(new Error("D1_ERROR: database is locked"))
    const handler = { accepted, blocked, pending }[bucket]
    const schema = { accepted: CommunityAcceptedFriendsReadSchema, blocked: CommunityBlockedFriendsReadSchema, pending: CommunityPendingFriendsReadSchema }[bucket]
    const response = await handler(request(bucket))
    expect(schema.parse(await response.json())).toEqual({ contractVersion: BUSINESS_SCHEMA_VERSION, [bucket === "accepted" ? "friends" : bucket]: [], stale: true })
    await expect(owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn, staleTime: 0, retry: false })).rejects.toThrow("stale D1 read")
    expect(owner.registry.collections.friendships.get("accepted-row")).toMatchObject({ userId: "accepted-peer", kind: "accepted" })
    expect(owner.registry.collections.profiles.get("accepted-peer")?.name).toBe("Full accepted-peer")
  })

  it.each(["accepted", "blocked", "pending"].flatMap(bucket => ["users", "profiles"].map(query => ({ bucket: bucket as "accepted" | "blocked" | "pending", query: query as "users" | "profiles" }))))("rethrows $bucket full resource $query non-BUSY errors", async ({ bucket, query }) => {
    const error = new Error("controlled programming failure")
    mocks[query].mockRejectedValue(error)
    const handler = { accepted, blocked, pending }[bucket]
    await expect(handler(request(bucket))).rejects.toBe(error)
    expect(mocks[query]).toHaveBeenCalledOnce()
  })

})
