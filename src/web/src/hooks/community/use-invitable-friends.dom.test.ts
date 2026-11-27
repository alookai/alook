import { friendBucketScenarioFixture } from "@/test/community-resource-fixtures"
import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { useInvitableFriends } from "./use-invitable-friends"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))

describe("Native invitable friend projection", () => {
  it("loads server-excluded accepted friends in one request without fetching server members", async () => {
    let release!: (value: unknown) => void
    const pendingAccepted = new Promise((resolve) => { release = resolve })
    const friend = { id: "friendship_cold", userId: "friend_cold", name: "Cold friend", discriminator: "0042", avatar: "C", avatarVersion: 0, status: "offline", sub: "" }
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path === "/api/community/friends/accepted?excludeServerId=server_1") return pendingAccepted
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(({ open }) => useInvitableFriends("server_1", open), { initialProps: { open: false }, wrapper })
    expect(api).not.toHaveBeenCalled()

    await act(async () => view.rerender({ open: true }))
    await waitFor(() => expect(view.result.current.isFetching).toBe(true))
    expect(view.result.current.data).toBeUndefined()
    expect(view.result.current.isSuccess).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)

    await act(async () => { release({ ...friendBucketScenarioFixture("friends", [friend]), totalFriends: 3 }); await pendingAccepted })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.friends).toEqual([expect.objectContaining(friend)])
    expect(view.result.current.totalFriends).toBe(3)
    expect(api.mock.calls.filter(([path]) => String(path).includes("/members"))).toHaveLength(0)
  })

  it("reports one failed request and recovers to an empty picker on refetch", async () => {
    let failing = true
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path === "/api/community/friends/accepted?excludeServerId=server_1") {
        if (failing) throw new Error("Friends unavailable")
        return { ...friendBucketScenarioFixture("friends", []), totalFriends: 0 }
      }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(() => useInvitableFriends("server_1"), { wrapper })
    await waitFor(() => expect(view.result.current.isError).toBe(true))
    expect(api).toHaveBeenCalledTimes(1)
    failing = false
    await act(async () => { await view.result.current.refetch() })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.friends).toEqual([])
    expect(view.result.current.data).toEqual({ friends: [] })
  })

  it("seeds explicit peer identities while preserving relationship presentation", async () => {
    const identified = { id: "friendship_1", userId: "friend_1", name: "Alice", discriminator: "0042", avatar: "A", avatarVersion: 2, status: "offline", sub: "" }
    const other = { id: "relationship_other", userId: "friend_other", name: "Other", discriminator: "0000", avatar: "L", avatarVersion: 0, status: "offline", sub: "" }
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path === "/api/community/friends/accepted?excludeServerId=server_1") {
        return { ...friendBucketScenarioFixture("friends", [identified, other]), totalFriends: 2 }
      }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(() => useInvitableFriends("server_1"), { wrapper })
    await waitFor(() => expect(view.result.current.friends).toEqual([
      expect.objectContaining(identified), expect.objectContaining(other),
    ]))
    expect(owner.client.getQueryData(communityKeys.invitableFriends("server_1"))).toEqual({ serverId: "server_1", friendIds: ["friendship_1", "relationship_other"], totalFriends: 2, observed: true })
    expect(owner.registry.collections.profiles.get("friend_1")?.name).toBe("Alice")
    expect(owner.registry.collections.friendships.get("relationship_other")).toMatchObject({ id: "relationship_other", userId: "friend_other", kind: "accepted" })
  })
})
