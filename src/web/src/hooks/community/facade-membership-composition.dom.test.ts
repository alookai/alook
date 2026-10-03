import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
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
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
function buckets(url: string) {
  if (url.endsWith("/blocked")) return { blocked: [] }
  if (url.endsWith("/pending")) return { pending: [] }
  throw new Error("unexpected " + url)
}
describe("membership facade composition", () => {
  it("pages the canonical server roster before subtracting channel members", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (new URL(url, "https://alook.test").searchParams.get("cursor") === "next") return { members: [bob], hasMore: false }
      if (url.includes("/servers/s1/members?")) return { members: [alice], hasMore: true, cursor: "next" }
      if (url === "/api/community/channels/c1/members") return { members: [alice] }
      return buckets(url)
    })
    const rendered = renderHook(() => useAddableMembers("s1", "c1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.members).toEqual([{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "b", avatarVersion: 0 }]))
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).includes("/servers/s1/members?"))).toHaveLength(2)
    expect(client.getQueryData(communityKeys.channelAddableMembers("c1"))).toEqual({ serverId: "s1", relation: "access", members: [{ id: alice.id, userId: alice.userId }, { id: bob.id, userId: bob.userId }] })
    expect(registry.collections.profiles.get("bob")?.name).toBe("Bob")
  })

  it("subtracts canonical server members from accepted friends", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted") return { friends: [{ ...alice, id: "friend_1" }, { ...bob, id: "friend_2" }] }
      if (url.includes("/api/community/servers/s1/members?")) return { members: [alice], hasMore: false }
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.friends.map((friend) => friend.userId)).toEqual(["bob"]))
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toEqual({ serverId: "s1", friendIds: ["friend_1", "friend_2"] })
    expect(registry.collections.friendships.get("friend_2")).toMatchObject({ userId: "bob", kind: "accepted" })
  })

  it("rejects a stale accepted-friends read instead of caching a false-empty candidate set", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted") return { friends: [], stale: true }
      if (url.includes("/api/community/servers/s1/members?")) return { members: [], hasMore: false }
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ message: "stale D1 read" }))
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toBeUndefined()
    expect(registry.collections.friendships.size).toBe(0)
  })

  it("keeps last-good candidates when a QueryClient refetch gets a stale response", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted") return { friends: [{ ...bob, id: "friend_2" }] }
      if (url.includes("/api/community/servers/s1/members?")) return { members: [], hasMore: false }
      return buckets(url)
    })
    const rendered = renderHook(() => useInvitableFriends("s1"), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.friends).toHaveLength(1))
    const lastGood = client.getQueryData(communityKeys.invitableFriends("s1"))
    apiFetchMock.mockImplementation(async (url: string) => url === "/api/community/friends/accepted" ? { friends: [], stale: true } : url.includes("/members?") ? { members: [], hasMore: false } : buckets(url))
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ message: "stale D1 read" }))
    expect(client.getQueryData(communityKeys.invitableFriends("s1"))).toBe(lastGood)
    expect(rendered.result.current.friends).toMatchObject([{ userId: "bob", name: "Bob" }])
  })
})
