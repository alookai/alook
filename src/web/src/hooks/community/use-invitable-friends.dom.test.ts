import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { useInvitableFriends } from "./use-invitable-friends"
import { friendsQueryFn, useFriends } from "./use-friends"
import { fetchAllServerMembers } from "./fetch-all-server-members"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))

describe("Native invitable friend projection", () => {
  it("keeps a cold shared friends read provisional until its accepted request completes", async () => {
    let release!: (value: unknown) => void
    const accepted = new Promise((resolve) => { release = resolve })
    const friend = { id: "friendship_cold", userId: "friend_cold", name: "Cold friend", discriminator: "0042", avatar: "C", avatarVersion: 0, status: "offline", sub: "" }
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accepted")) return accepted
      if (path.endsWith("/blocked")) return { blocked: [] }
      if (path.endsWith("/pending")) return { pending: [] }
      if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(({ open }) => ({ shell: useFriends(), picker: useInvitableFriends("server_1", open) }), { initialProps: { open: false }, wrapper })
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1))

    await act(async () => view.rerender({ open: true }))
    await waitFor(() => expect(view.result.current.picker.isFetching).toBe(true))
    expect(view.result.current.picker.data).toBeUndefined()
    expect(view.result.current.picker.isSuccess).toBe(false)
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1)

    await act(async () => { release({ friends: [friend] }); await accepted })
    await waitFor(() => expect(view.result.current.picker.isSuccess).toBe(true))
    expect(view.result.current.picker.friends).toEqual([expect.objectContaining(friend)])
    expect(view.result.current.shell.friends).toEqual([expect.objectContaining(friend)])
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1)
  })

  it("reuses warm canonical friends under the five-second policy without another accepted request", async () => {
    const friend = { id: "friendship_warm", userId: "friend_warm", name: "Warm friend", discriminator: "0042", avatar: "W", avatarVersion: 0, status: "offline", sub: "" }
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accepted")) return { friends: [friend] }
      if (path.endsWith("/blocked")) return { blocked: [] }
      if (path.endsWith("/pending")) return { pending: [] }
      if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(({ open }) => ({ shell: useFriends(), picker: useInvitableFriends("server_1", open) }), { initialProps: { open: false }, wrapper })
    await waitFor(() => expect(view.result.current.shell.isSuccess).toBe(true))
    expect(view.result.current.shell.friends).toEqual([expect.objectContaining(friend)])
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1)

    await act(async () => view.rerender({ open: true }))
    await waitFor(() => expect(view.result.current.picker.isSuccess).toBe(true))
    expect(view.result.current.picker.friends).toEqual([expect.objectContaining(friend)])
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1)
    expect(api.mock.calls.filter(([path]) => path.includes("/members"))).toHaveLength(1)
  })

  it.each(["cold", "warm"] as const)("keeps %s raw friend IDs when query defaults select an empty view", async (state) => {
    const friend = { id: "friendship_selected", userId: "friend_selected", name: "Selected friend", discriminator: "0042", avatar: "S", avatarVersion: 0, status: "offline", sub: "" }
    api.mockClear()
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accepted")) return { friends: [friend] }
      if (path.endsWith("/blocked")) return { blocked: [] }
      if (path.endsWith("/pending")) return { pending: [] }
      if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
      throw new Error(`Unexpected friend request: ${path}`)
    })
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
    if (state === "warm") await owner.client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn })
    const select = vi.fn(() => ({ ids: [] }))
    owner.client.setQueryDefaults(communityKeys.friends(), { select })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const view = renderHook(() => useInvitableFriends("server_1"), { wrapper })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.friends).toEqual([expect.objectContaining(friend)])
    expect(owner.client.getQueryData(communityKeys.friends())).toMatchObject({ ids: [friend.id] })
    expect(select).toHaveBeenCalled()
    expect(api.mock.calls.filter(([path]) => path.endsWith("/accepted"))).toHaveLength(1)
  })

  it("keeps raw complete member pages with a default selector on fetched and cached reads", async () => {
    const member = { id: "member_selected", userId: "user_selected", name: "Member", discriminator: "0042", avatar: "M", avatarVersion: 0, status: "offline", sub: "", role: "member" }
    api.mockClear()
    api.mockResolvedValue({ members: [member], hasMore: false, cursor: null, limit: 100, total: 1 })
    const owner = await createCommunityQueryOwner()
    const select = vi.fn(() => ({ pages: [], pageParams: [] }))
    owner.client.setQueryDefaults(communityKeys.members("server_1"), { select })
    try {
      const fetched = await fetchAllServerMembers(owner.client, "server_1")
      expect(fetched).toEqual([expect.objectContaining({ id: member.id, userId: member.userId, name: member.name })])
      expect(await fetchAllServerMembers(owner.client, "server_1")).toEqual(fetched)
      expect(select).toHaveBeenCalled()
      expect(api).toHaveBeenCalledOnce()
    } finally { await owner.registry.cleanup(); owner.client.clear() }
  })

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
