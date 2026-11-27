import { serverMembersReadFixture, friendBucketScenarioFixture, staleFriendBucketFixture } from "@/test/community-resource-fixtures"
import { BUSINESS_SCHEMA_VERSION, CommunityMembersReadSchema } from "@alook/shared"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { useAddableMembers } from "./use-channel-members"
import { useInvitableFriends } from "./use-invitable-friends"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
const alice = { id: "membership_1", userId: "alice", name: "Alice", discriminator: "0001", avatar: "a", avatarVersion: 0, status: "offline", sub: "", role: "member", source: "explicit", isCreator: false }
const bob = { ...alice, id: "membership_2", userId: "bob", name: "Bob", discriminator: "0002", avatar: "b" }
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  apiFetchMock.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
})
beforeEach(() => async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
function buckets(url: string) {
  if (url.endsWith("/blocked")) return friendBucketScenarioFixture("blocked", [])
  if (url.endsWith("/pending")) return friendBucketScenarioFixture("pending", [])
  throw new Error("unexpected " + url)
}
describe("membership facade composition", () => {
  it("fetches server-excluded addable channel members in a single request", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const parsed = new URL(url, "https://alook.test")
      if (parsed.pathname === "/api/community/servers/s1/members" && parsed.searchParams.get("excludeChannelId") === "c1") {
        return serverMembersReadFixture("s1", [bob])
      }
      return buckets(url)
    })
    const rendered = renderHook(() => useAddableMembers("s1", "c1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.members).toEqual([{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "b", avatarVersion: 0 }]))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(communityKeys.channelAddableMembers("c1"))).toEqual({ serverId: "s1", relation: "access", members: [{ id: bob.id, userId: bob.userId }], observed: true })
    expect(registry.collections.serverMemberships.get("s1:bob")).toMatchObject({ memberId: bob.id })
    expect(registry.collections.profiles.get("bob")?.name).toBe("Bob")
  })

  it("fetches server-excluded accepted friends in a single request", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted?excludeServerId=s1") {
        return { ...friendBucketScenarioFixture("friends", [{ ...bob, id: "friend_2" }]), totalFriends: 2 }
      }
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.friends.map((friend) => friend.userId)).toEqual(["bob"]))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toEqual({ serverId: "s1", friendIds: ["friend_2"], totalFriends: 2, observed: true })
    expect(registry.collections.friendships.get("friend_2")).toMatchObject({ userId: "bob", kind: "accepted" })
  })

  it("rejects a stale accepted-friends read instead of caching a false-empty candidate set", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted?excludeServerId=s1") return staleFriendBucketFixture("friends")
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ message: "stale D1 read" }))
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toBeUndefined()
    expect(registry.collections.friendships.size).toBe(0)
  })

  it("keeps last-good candidates when a QueryClient refetch gets a stale response", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted?excludeServerId=s1") {
        return { ...friendBucketScenarioFixture("friends", [{ ...bob, id: "friend_2" }]), totalFriends: 1 }
      }
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.friends).toHaveLength(1))
    const lastGood = client.getQueryData(communityKeys.invitableFriends("s1"))
    apiFetchMock.mockImplementation(async (url: string) => url === "/api/community/friends/accepted?excludeServerId=s1" ? staleFriendBucketFixture("friends") : buckets(url))
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ message: "stale D1 read" }))
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toBe(lastGood)
    expect(rendered.result.current.friends).toMatchObject([{ userId: "bob", name: "Bob" }])
  })
})
