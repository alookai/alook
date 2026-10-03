import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useFriendshipRows, useAttentionItems } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishCommunityFriendships, publishAccountAttentionSnapshot, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import * as commands from "./friends"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
type Row = Parameters<typeof publishCommunityFriendships>[1][number]
const incoming = (id: string): Row => ({ id, userId: `u_${id}`, kind: "incoming" })
function attention() {
  const rows = Array.from(registry.collections.friendships.values()).filter((row) => row.kind === "incoming")
  return { scopes: [], limit: 50, truncated: false, items: rows.map((row) => ({ id: `friend_request:${row.id}`, kind: "friend_request" as const, sourceId: row.id, actorUserId: row.userId, createdAt: "2026-09-27T00:00:00.000Z" })), included: { servers: [], channels: [], dms: [], messages: [], profiles: rows.map((row) => ({ userId: row.userId, name: row.id, discriminator: "0001", avatar: row.id, avatarVersion: 1 })) } }
}
beforeEach(async () => {
  api.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
  api.mockImplementation(async (path: string) => path === "/api/community/users/me/attention" ? attention() : undefined)
})
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
function seed(rows: Row[] = [incoming("a"), incoming("b")], transport = true) {
  publishCommunityFriendships(client, rows, { token: captureCommunityLiveSnapshotToken(client) })
  publishAccountAttentionSnapshot(client, { snapshot: attention(), proof: { token: captureCommunityLiveSnapshotToken(client) } })
  if (transport) client.setQueryData(communityKeys.friends(), { ids: rows.map((row) => row.id) })
}
function mount<T>(hook: () => T) { return renderHook(() => ({ command: hook(), rows: useFriendshipRows(), items: useAttentionItems() }), { wrapper: Owner }) }
function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function hold() { const held = deferred(); api.mockImplementationOnce(() => held.promise); return held }
function start<T>(command: { mutateAsync: (args: T) => Promise<unknown> }, args: T) { let pending!: Promise<unknown>; act(() => { pending = command.mutateAsync(args).catch((error: unknown) => error) }); return pending }
function ids(kind?: Row["kind"]) { return Array.from(registry.collections.friendships.values()).filter((row) => !kind || row.kind === kind).map((row) => row.id).sort() }
function exactFriends(spy: ReturnType<typeof vi.spyOn>) { expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: communityKeys.friends(), exact: true, predicate: expect.any(Function) }), { cancelRefetch: false }) }

describe("native friendship commands", () => {
  it("invalidates the original Friends resource after sending", async () => {
    seed(); const rendered = mount(commands.useSendFriendRequest), invalidate = vi.spyOn(client, "invalidateQueries")
    await act(async () => { await rendered.result.current.command.mutateAsync({ username: "alice" }) })
    exactFriends(invalidate)
  })
  it("posts both the exact userId and handle", async () => {
    const rendered = mount(commands.useSendFriendRequest)
    await act(async () => { await rendered.result.current.command.mutateAsync({ userId: "u_1", username: "alice#0042" }) })
    expect(api.mock.calls[0]![0]).toBe("/api/community/friends/request")
    expect(JSON.parse(api.mock.calls[0]![1].body)).toEqual({ userId: "u_1", username: "alice#0042" })
  })
  it("commits attention removal and starts qualified reconciliation after ACK", async () => {
    seed(); const rendered = mount(commands.useAcceptFriendRequest)
    await act(async () => { await rendered.result.current.command.mutateAsync({ friendshipId: "a" }) })
    await waitFor(() => expect(rendered.result.current.items.map((row) => row.sourceId)).toEqual(["b"]))
    expect(registry.collections.friendships.get("a")?.kind).toBe("accepted")
    expect(api).toHaveBeenCalledWith("/api/community/users/me/attention", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
  })
  it("does not compensate a late rejection after its actual native action is terminal", async () => {
    seed(); const held = hold(), rendered = mount(commands.useAcceptFriendRequest), success = vi.fn(), error = vi.fn()
    let pending!: Promise<unknown>
    act(() => { pending = rendered.result.current.command.mutateAsync({ friendshipId: "a" }, { onSuccess: success, onError: error }) })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    await act(async () => { held.resolve(); await pending; held.reject(new Error("late failure")) })
    expect(success).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled()
    expect(registry.collections.friendships.get("a")?.kind).toBe("accepted")
    expect(registry.collections.attentionItems.has("friend_request:a")).toBe(false)
  })
  it("keeps an intervening canonical terminal event after an action fails", async () => {
    seed(); const held = hold(), rendered = mount(commands.useAcceptFriendRequest), pending = start(rendered.result.current.command, { friendshipId: "a" })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    act(() => projectCommunityWsEventToDb(client, { type: "community:friend.reject", friendshipId: "a" }))
    await act(async () => { held.reject(new Error("failed")); await pending })
    expect(ids()).toEqual(["b"])
    expect(registry.collections.attentionItems.has("friend_request:a")).toBe(false)
    expect(api.mock.calls.some(([path]) => path === "/api/community/users/me/attention")).toBe(true)
  })
  it.each(["accept", "reject"] as const)("preserves the pending canonical relationship and sibling through failed %s", async (action) => {
    seed(); const before = registry.collections.friendships.get("a"), held = hold(), rendered = mount(action === "accept" ? commands.useAcceptFriendRequest : commands.useRejectFriendRequest)
    const cancel = vi.spyOn(client, "cancelQueries"), pending = start(rendered.result.current.command, { friendshipId: "a" })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(ids("incoming")).toEqual(["a", "b"])
    expect(client.getMutationCache().find({ mutationKey: ["community", "friend-request", action], status: "pending" })).toBeDefined()
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ queryKey: communityKeys.friends(), exact: true, predicate: expect.any(Function) }))
    await act(async () => { held.reject(new Error("boom")); await pending })
    expect(registry.collections.friendships.get("a")).toBe(before)
    expect(ids("incoming")).toEqual(["a", "b"])
  })
  it.each([
    { successfulId: "a", failedId: "b", order: "failed-first" },
    { successfulId: "a", failedId: "b", order: "success-first" },
    { successfulId: "b", failedId: "a", order: "failed-first" },
    { successfulId: "b", failedId: "a", order: "success-first" },
  ])("never resurrects $successfulId when $failedId fails $order", async ({ successfulId, failedId, order }) => {
    seed(); const a = deferred(), b = deferred(), gates = { a, b }, rendered = mount(commands.useRejectFriendRequest)
    api.mockImplementation(async (path: string) => path === "/api/community/users/me/attention" ? attention() : gates[path.includes("/a/") ? "a" : "b"].promise)
    const first = start(rendered.result.current.command, { friendshipId: "a" }), second = start(rendered.result.current.command, { friendshipId: "b" })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    const settleSuccess = async () => { gates[successfulId as "a" | "b"].resolve(); await (successfulId === "a" ? first : second) }
    const settleFailure = async () => { gates[failedId as "a" | "b"].reject(new Error("failed")); await (failedId === "a" ? first : second) }
    await act(async () => { if (order === "failed-first") { await settleFailure(); await settleSuccess() } else { await settleSuccess(); await settleFailure() } })
    expect(ids("incoming")).toEqual([failedId])
    expect(registry.collections.attentionItems.has(`friend_request:${successfulId}`)).toBe(false)
  })
  it("preserves an unrelated canonical arrival when an optimistic removal rolls back", async () => {
    seed([{ ...incoming("a"), kind: "accepted" }]); const held = hold(), rendered = mount(commands.useRemoveFriend), pending = start(rendered.result.current.command, { friendshipId: "a" })
    await waitFor(() => expect(ids()).toEqual([]))
    act(() => projectCommunityWsEventToDb(client, { type: "community:friend.request", friendship: { id: "c", requesterId: "u_c", addresseeId: "viewer", status: "pending", createdAt: "2026-09-27T00:00:00.000Z" } }))
    await act(async () => { held.reject(new Error("failed")); await pending })
    expect(ids()).toEqual(["a", "c"])
    expect(client.getQueryData(communityKeys.inboxUnreads())).toBeUndefined()
  })
  it("never reconstructs an absent Friends transport after failure", async () => {
    seed([incoming("a")], false); const held = hold(), rendered = mount(commands.useAcceptFriendRequest), pending = start(rendered.result.current.command, { friendshipId: "a" })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    await act(async () => { held.reject(new Error("failed")); await pending })
    expect(client.getQueryData(communityKeys.friends())).toBeUndefined()
  })
  it("awaits settled invalidation of the active original Friends resource", async () => {
    seed(); const refresh = deferred(), observer = new QueryObserver(client, { queryKey: communityKeys.friends(), queryFn: () => refresh.promise, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => undefined), rendered = mount(commands.useAcceptFriendRequest)
    let settled = false
    const pending = start(rendered.result.current.command, { friendshipId: "a" }).then(() => { settled = true })
    await waitFor(() => expect(client.getQueryState(communityKeys.friends())?.fetchStatus).toBe("fetching"))
    expect(settled).toBe(false)
    await act(async () => { refresh.resolve({ ids: ["a", "b"] }); await pending })
    expect(settled).toBe(true); unsubscribe()
  })
  it.each(["success", "failure"] as const)("optimistically removes an outgoing request and settles %s", async (outcome) => {
    seed([{ ...incoming("a"), kind: "outgoing" }]); const held = hold(), rendered = mount(commands.useCancelBotFriendRequest), pending = start(rendered.result.current.command, { requestId: "a" })
    await waitFor(() => expect(ids()).toEqual([]))
    expect(api).toHaveBeenCalledWith("/api/community/friends/a", expect.objectContaining({ method: "DELETE", assertActive: expect.any(Function) }))
    await act(async () => { if (outcome === "success") held.resolve(); else held.reject(new Error("failed")); await pending })
    expect(ids()).toEqual(outcome === "success" ? [] : ["a"])
  })
  it("optimistically removes an accepted friend and restores only its own failure", async () => {
    seed([{ ...incoming("a"), kind: "accepted" }, { ...incoming("b"), kind: "accepted" }]); const held = hold(), rendered = mount(commands.useRemoveFriend), pending = start(rendered.result.current.command, { friendshipId: "a" })
    await waitFor(() => expect(ids()).toEqual(["b"]))
    await act(async () => { held.reject(new Error("failed")); await pending })
    expect(ids()).toEqual(["a", "b"])
  })
  it("keeps an absent transport absent and qualifies its refresh after removal", async () => {
    const rendered = mount(commands.useRemoveFriend), invalidate = vi.spyOn(client, "invalidateQueries")
    await act(async () => { await rendered.result.current.command.mutateAsync({ friendshipId: "missing" }) })
    expect(client.getQueryData(communityKeys.friends())).toBeUndefined(); exactFriends(invalidate)
  })
  it("publishes a canonical block and invalidates Friends", async () => {
    seed(); const rendered = mount(commands.useBlockUser), invalidate = vi.spyOn(client, "invalidateQueries")
    await act(async () => { await rendered.result.current.command.mutateAsync({ userId: "u_a" }) })
    expect(registry.collections.friendships.get("blocked:u_a")?.kind).toBe("blocked")
    expect(registry.collections.attentionItems.has("friend_request:a")).toBe(false); exactFriends(invalidate)
  })
  it("restores a blocked row when unblock fails", async () => {
    seed([{ ...incoming("a"), kind: "blocked" }]); const held = hold(), rendered = mount(commands.useUnblockUser), pending = start(rendered.result.current.command, { userId: "u_a" })
    await waitFor(() => expect(ids()).toEqual([]))
    await act(async () => { held.reject(new Error("failed")); await pending })
    expect(ids("blocked")).toEqual(["a"])
  })
  it.each(["success", "failure"] as const)("withholds old-owner %s and external callbacks after account retirement", async (outcome) => {
    seed(); const held = hold(), rendered = mount(commands.useAcceptFriendRequest), success = vi.fn(), error = vi.fn()
    let pending!: Promise<unknown>
    act(() => { pending = rendered.result.current.command.mutateAsync({ friendshipId: "a" }, { onSuccess: success, onError: error }).catch((cause: unknown) => cause) })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    registry.runtime.ws.actions.activateProfileAccount("other"); registry.runtime.ws.actions.activateProfileAccount("viewer")
    await act(async () => { if (outcome === "success") held.resolve(); else held.reject(new Error("failed")); expect(await pending).toMatchObject({ name: "AbortError" }) })
    expect(ids("incoming")).toEqual(["a", "b"])
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(api).toHaveBeenCalledOnce()
  })
})
