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
  it("reports one failed friends retry chain and recovers to an empty picker", async () => {
    let failing = true
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accepted")) {
        if (failing) throw new Error("Friends unavailable")
        return { friends: [] }
      }
      if (path.endsWith("/blocked")) return { blocked: [] }
      if (path.endsWith("/pending")) return { pending: [] }
      if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(() => useInvitableFriends("server_1"), { wrapper })
    await waitFor(() => expect(view.result.current.isError).toBe(true))
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(2)
    failing = false
    await act(async () => { await view.result.current.refetch() })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.friends).toEqual([])
    expect(view.result.current.data).toEqual({ friends: [] })
  })
  it("seeds identified friends and preserves identifier-free presentation", async () => {
    const identified = { id: "friendship_1", userId: "friend_1", name: "Alice", discriminator: "0042", avatar: "A", avatarVersion: 2, status: "offline", sub: "" }
    const legacy = { id: "legacy", name: "Legacy", discriminator: "0000", avatar: "L", avatarVersion: 0, status: "offline", sub: "" }
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accepted")) return { friends: [identified, legacy] }
      if (path.endsWith("/blocked")) return { blocked: [] }
      if (path.endsWith("/pending")) return { pending: [] }
      if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(() => useInvitableFriends("server_1"), { wrapper })
    await waitFor(() => expect(view.result.current.friends).toEqual([
      expect.objectContaining(identified), expect.objectContaining(legacy),
    ]))
    expect(owner.client.getQueryData(communityKeys.invitableFriends("server_1"))).toEqual({ serverId: "server_1", friendIds: ["friendship_1", "legacy"] })
    expect(owner.registry.collections.profiles.get("friend_1")?.name).toBe("Alice")
    expect(owner.registry.collections.friendships.get("legacy")).toMatchObject({ id: "legacy", kind: "accepted" })
  })
})
