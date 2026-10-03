import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityDbProvider, useFriendshipRows } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishCommunityFriendships, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { useAcceptFriendRequest, useRejectFriendRequest } from "./mutations/friends"
import { useFriendRequestActionState } from "./use-friend-request-action-state"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
beforeEach(() => { api.mockReset(); api.mockResolvedValue(undefined) })
afterEach(() => vi.useRealTimers())
async function fixture() {
  const { client, registry } = await createCommunityQueryOwner()
  const seed = (ids: string[]) => publishCommunityFriendships(client, ids.map((id) => ({ id, userId: `user-${id}`, kind: "incoming" })), { token: captureCommunityLiveSnapshotToken(client) })
  seed(["a", "b"])
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children))
  const commands = renderHook(() => ({ accept: useAcceptFriendRequest(), reject: useRejectFriendRequest() }), { wrapper })
  const onAccept = (id: string) => commands.result.current.accept.mutateAsync({ friendshipId: id })
  const onReject = (id: string) => commands.result.current.reject.mutateAsync({ friendshipId: id })
  const surfaces = renderHook(() => {
    const rows = useFriendshipRows().filter((row) => row.kind === "incoming" || row.kind === "outgoing")
    return { friends: useFriendRequestActionState({ rows, onAccept, onReject, surface: "friends" }), inbox: useFriendRequestActionState({ rows, onAccept, onReject, surface: "inbox" }) }
  }, { wrapper })
  return { client, registry, seed, wrapper, commands, surfaces }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
describe("Native friend-request action projection", () => {
  it("does not create rows from unrelated mutation variables or an absent canonical request", async () => {
    const { surfaces, seed } = await fixture()
    act(() => seed([]))
    await waitFor(() => expect(surfaces.result.current.inbox.items).toEqual([]))
    expect(surfaces.result.current.friends.items).toEqual([])
  })
  it("keys an actor-less display row by its request id", async () => {
    const { wrapper, commands } = await fixture(); const gate = deferred(); api.mockReturnValue(gate.promise)
    const surface = renderHook(() => useFriendRequestActionState({ rows: [{ id: "a" }], onAccept: (id) => commands.result.current.accept.mutateAsync({ friendshipId: id }), surface: "inbox" }), { wrapper })
    let request!: Promise<void>
    act(() => { request = surface.result.current.act(surface.result.current.items[0]!, "accept") })
    await waitFor(() => expect(surface.result.current.items[0]).toMatchObject({ row: { id: "a" }, action: "accept", status: "pending" }))
    await act(async () => { gate.resolve(); await request })
  })
  it("keeps the canonical request through ACK and locks only its id on both surfaces", async () => {
    const { registry, surfaces } = await fixture(); const gate = deferred(); api.mockReturnValue(gate.promise)
    let request!: Promise<void>
    act(() => { request = surfaces.result.current.friends.act(surfaces.result.current.friends.items[0]!, "accept") })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(registry.collections.friendships.get("a")?.kind).toBe("incoming")
    for (const surface of Object.values(surfaces.result.current)) expect(surface.items.map((item) => item.status)).toEqual(["pending", undefined])
    await act(async () => { gate.resolve(); await request })
    await waitFor(() => expect(surfaces.result.current.friends.items.map((item) => item.row.id)).toEqual(["b"]))
  })
  it("retains an independent error and retries the same action", async () => {
    const { client, surfaces } = await fixture(); api.mockRejectedValueOnce(new Error("offline"))
    await act(async () => { await surfaces.result.current.friends.act(surfaces.result.current.friends.items[0]!, "reject") })
    await waitFor(() => expect(surfaces.result.current.inbox.items[0]).toMatchObject({ action: "reject", status: "error" }))
    expect(surfaces.result.current.inbox.items[0]?.error).toContain("Try again")
    expect(surfaces.result.current.friends.items[1]?.status).toBeUndefined()
    await act(async () => { await surfaces.result.current.inbox.retry(surfaces.result.current.inbox.items[0]!) })
    await waitFor(() => expect(surfaces.result.current.friends.items.map((item) => item.row.id)).toEqual(["b"]))
    expect(api.mock.calls.filter(([path]) => path.endsWith("/reject"))).toHaveLength(2)
    expect(client.getMutationCache().findAll({ mutationKey: ["community", "friend-request"] })).toHaveLength(0)
  })
  it("tracks concurrent ids without sharing pending state", async () => {
    const { surfaces } = await fixture(); const a = deferred(), b = deferred()
    api.mockImplementation((path: string) => path.endsWith("/a/accept") ? a.promise : path.endsWith("/b/accept") ? b.promise : Promise.resolve(undefined))
    let first!: Promise<void>, second!: Promise<void>
    act(() => { first = surfaces.result.current.friends.act(surfaces.result.current.friends.items[0]!, "accept"); second = surfaces.result.current.inbox.act(surfaces.result.current.inbox.items[1]!, "accept") })
    await waitFor(() => expect(surfaces.result.current.inbox.items.map((item) => item.status)).toEqual(["pending", "pending"]))
    await act(async () => { b.resolve(); await second })
    expect(surfaces.result.current.friends.items[0]?.status).toBe("pending")
    await act(async () => { a.resolve(); await first })
  })
  it("retains Retry after its mutation observer detaches and the old GC deadline passes", async () => {
    const { registry, commands, surfaces } = await fixture(); api.mockRejectedValueOnce(new Error("offline"))
    await act(async () => { await surfaces.result.current.inbox.act(surfaces.result.current.inbox.items[0]!, "reject") })
    await waitFor(() => expect(surfaces.result.current.friends.items[0]?.status).toBe("error"))
    vi.useFakeTimers()
    commands.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000) })
    expect(registry.runtime.lifecycle.get().active).toBe(true)
    expect(registry.collections.friendships.get("a")?.kind).toBe("incoming")
    for (const surface of Object.values(surfaces.result.current)) expect(surface.items[0]).toMatchObject({ row: { id: "a" }, action: "reject", status: "error" })
  })
  it("cleans retained failures after qualified canonical terminal absence", async () => {
    const { client, surfaces, seed } = await fixture(); api.mockRejectedValueOnce(new Error("offline"))
    await act(async () => { await surfaces.result.current.inbox.act(surfaces.result.current.inbox.items[0]!, "accept") })
    await waitFor(() => expect(surfaces.result.current.friends.items[0]?.status).toBe("error"))
    act(() => seed(["b"]))
    expect(client.getMutationCache().findAll({ mutationKey: ["community", "friend-request"] })).toHaveLength(0)
    await waitFor(() => expect(surfaces.result.current.inbox.items.map((item) => item.row.id)).toEqual(["b"]))
  })
  it("never rebuilds a blocked user from failure and clears native errors on account retirement", async () => {
    const { client, registry, surfaces } = await fixture(); const gate = deferred(); api.mockReturnValue(gate.promise)
    let request!: Promise<void>
    act(() => { request = surfaces.result.current.friends.act(surfaces.result.current.friends.items[0]!, "accept") })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    act(() => projectCommunityWsEventToDb(client, { type: "community:friend.block", userId: "user-a" }))
    api.mockResolvedValue(undefined)
    await act(async () => { gate.reject(new Error("late")); await request })
    expect(surfaces.result.current.friends.items.map((item) => item.row.id)).toEqual(["b"])
    expect(client.getMutationCache().findAll({ mutationKey: ["community", "friend-request"] })).toHaveLength(0)
    api.mockRejectedValueOnce(new Error("offline"))
    await act(async () => { await surfaces.result.current.friends.act(surfaces.result.current.friends.items[0]!, "reject") })
    await waitFor(() => expect(surfaces.result.current.inbox.items[0]?.status).toBe("error"))
    await act(async () => { await registry.cleanup(); client.clear() })
    expect(client.getMutationCache().getAll()).toHaveLength(0)
  })
})
