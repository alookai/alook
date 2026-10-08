import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React, { useMemo } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { useServer, useServers } from "../use-servers"
import { useUpdateServer, useLeaveServer, useDeleteServer, useUploadServerIcon } from "./servers"
import { createOwnerServerDeleteRouteToken, cancelOwnerServerDelete, observeOwnerServerDeleteRouteCommit, isOwnerServerDeleteRouteProtected } from "@/lib/community/eject-server"
import { flushOwnerServerDeleteRouteCommit } from "../community-ws/scope-eviction"
import { dispatchCommunityWsEvent } from "../community-ws/registry"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { useCreateChannel, useCreateCategory, useDeleteCategory, useMoveChannel, useReorderChannels, useUpdateCategory, useReorderCategories, useDeleteChannel } from "./channels"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient
let update: ReturnType<typeof useUpdateServer>
let leave: ReturnType<typeof useLeaveServer>
let remove: ReturnType<typeof useDeleteServer>
let icon: ReturnType<typeof useUploadServerIcon>, updateCategory: ReturnType<typeof useUpdateCategory>, reorderCategories: ReturnType<typeof useReorderCategories>, deleteChannel: ReturnType<typeof useDeleteChannel>
let deleteCallbacks = { onSuccess: vi.fn(), onError: vi.fn() }
let createChannel: ReturnType<typeof useCreateChannel>, createCategory: ReturnType<typeof useCreateCategory>, deleteCategory: ReturnType<typeof useDeleteCategory>, moveChannel: ReturnType<typeof useMoveChannel>, reorderChannels: ReturnType<typeof useReorderChannels>
function Probe() {
  const currentClient = useQueryClient()
  const list = useServers(), detail = useServer("s1")
  const routeToken = useMemo(() => createOwnerServerDeleteRouteToken(currentClient), [currentClient])
  const currentUpdate = useUpdateServer(), currentLeave = useLeaveServer(), currentRemove = useDeleteServer({ ...deleteCallbacks, routeToken })
  const currentIcon = useUploadServerIcon(), currentUpdateCategory = useUpdateCategory(), currentReorderCategories = useReorderCategories(), currentDeleteChannel = useDeleteChannel()
  const currentCreateChannel = useCreateChannel(), currentCreateCategory = useCreateCategory(), currentDeleteCategory = useDeleteCategory(), currentMoveChannel = useMoveChannel(), currentReorderChannels = useReorderChannels()
  useLayoutEffect(() => { client = currentClient; update = currentUpdate; leave = currentLeave; remove = currentRemove; icon = currentIcon; updateCategory = currentUpdateCategory; reorderCategories = currentReorderCategories; deleteChannel = currentDeleteChannel; createChannel = currentCreateChannel; createCategory = currentCreateCategory; deleteCategory = currentDeleteCategory; moveChannel = currentMoveChannel; reorderChannels = currentReorderChannels })
  return <><output data-testid="server-list">{list.servers.map((s) => s.name).join(",")}</output><output data-testid="server-detail">{detail.server ? `${detail.server.name}|${detail.server.description}` : "missing"}</output><output data-testid="tree">{detail.server?.categories.map((c) => `${c.id}:${c.name}:${c.channels.map((ch) => `${ch.id}=${ch.name}`).join(",")}`).join("|")}</output></>
}
function Root({ id = sdk.id }: { id?: string }) { return <QueryProvider userId={id}><Probe /></QueryProvider> }
async function mount() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const held = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; signal?: AbortSignal; authenticationAccount?: string }) => {
    if (options.method && options.method !== "GET") return held
    const key = `${options.authenticationAccount}:${path}`
    if (seen.has(key)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("retired", "AbortError")), { once: true }))
    seen.add(key)
    if (path.endsWith("/categories")) return Promise.resolve({ categories: [{ id: "cat1", name: "General", private: false }, { id: "cat2", name: "Elsewhere", private: false }] })
    if (path.endsWith("/channels")) return Promise.resolve({ channels: [{ id: "c1", name: "general", categoryId: "cat1", type: "text" }] })
    return Promise.resolve({ servers: [{ id: "s1", name: "original", description: "before", discriminator: "0001", icon: null, ownerId: "A", role: "owner" }] })
  })
  const view = render(<Root />)
  await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("original|before"))
  return { view, resolve, reject, original: client }
}
function command() { return update.mutateAsync({ serverId: "s1", name: "Requested Name", description: "confirmed description" }).catch((error: unknown) => error) }
beforeEach(async () => { await clearAllPersistedCaches(); sdk.id = "A"; api.mockReset(); deleteCallbacks = { onSuccess: vi.fn(), onError: vi.fn() } })
afterEach(() => { api.mockReset(); if (client) cancelOwnerServerDelete(client, "s1") })
describe("actual canonical server and tree command owner", () => {
  it.each(["success", "failure"] as const)("keeps internal owner resources out of per-call %s callbacks", async (outcome) => {
    const { resolve, reject } = await mount()
    const input = { serverId: "s1", name: "Requested Name", description: "confirmed description" }
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>
    act(() => { result = update.mutateAsync(input, callbacks).catch((error: unknown) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true))
    const failure = new Error("callback boundary failure")
    await act(async () => { if (outcome === "success") resolve({ name: "requested-name" }); else reject(failure); await result })
    const terminal = outcome === "success" ? callbacks.onSuccess : callbacks.onError
    expect(terminal).toHaveBeenCalledOnce()
    expect(terminal.mock.calls[0]![1]).toEqual(input)
    expect(callbacks.onSettled).toHaveBeenCalledOnce()
    expect(callbacks.onSettled.mock.calls[0]![2]).toEqual(input)
    expect(outcome === "success" ? callbacks.onError : callbacks.onSuccess).not.toHaveBeenCalled()
  })
  it.each(["success", "failure"] as const)("suppresses retired-account per-call %s callbacks", async (outcome) => {
    const { view, resolve, reject, original } = await mount()
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>
    act(() => { result = update.mutateAsync({ serverId: "s1", name: "Old request", description: "old description" }, callbacks).catch((error: unknown) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true))
    sdk.id = "B"
    act(() => view.rerender(<Root id="B" />))
    await waitFor(() => expect(client).not.toBe(original))
    await act(async () => { if (outcome === "success") resolve({ name: "old-success" }); else reject(new Error("old-failure")); await result })
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSettled).not.toHaveBeenCalled()
  })
  it("stores only list and detail IDs while deduplicating cold identity bootstrap", async () => {
    const { original } = await mount()
    expect(original.getQueryData(communityKeys.servers())).toEqual(["s1"])
    expect(original.getQueryData(communityKeys.server("s1"))).toBe("s1")
    expect(api.mock.calls.filter(([path]) => path === "/api/community/servers")).toHaveLength(1)
  })
  it("shows native optimistic fields then commits normalized success before held refreshes can return", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() })
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("Requested Name|confirmed description"))
    expect(getCommunityDbRegistry(original)!.collections.servers.get("s1")?.name).toBe("Requested Name")
    await act(async () => { resolve({ name: "requested-name", description: "confirmed description" }); await result })
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("requested-name|confirmed description"))
    expect(screen.getByTestId("server-list").textContent).toBe("requested-name")
  })
  it("rolls back native fields to newer committed WS facts on ordinary failure", async () => {
    const { reject } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "PATCH")).toBe(true))
    act(() => projectCommunityWsEventToDb(client, { type: "community:server.update", serverId: "s1", changes: { name: "newer-ws" } }))
    await act(async () => { reject(new Error("denied")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("newer-ws|before"))
  })
  it("keeps newer WS name and confirms the independent description after successful settlement", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "PATCH")).toBe(true))
    act(() => projectCommunityWsEventToDb(original, { type: "community:server.update", serverId: "s1", changes: { name: "newer-ws" } }))
    await act(async () => { resolve({ name: "requested-name", description: "confirmed description" }); await result })
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("newer-ws|confirmed description"))
    expect(original.getQueryData(communityKeys.servers())).toEqual(["s1"])
    expect(original.getQueryData(communityKeys.server("s1"))).toBe("s1")
  })
  it("creates a native pending channel and maps its confirmed normalized identity with refresh held", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = createChannel.mutateAsync({ serverId: "s1", categoryId: "cat1", name: "New Room", type: "text" }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("=New Room"))
    await act(async () => { resolve({ channel: { id: "real-channel", name: "new-room", position: 1 } }); await result })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("real-channel=new-room"))
    const registry = getCommunityDbRegistry(original)!
    expect([...registry.collections.channels.keys()].some((id) => id.startsWith("tmp_ch_"))).toBe(false)
    expect(registry.collections.channels.get("real-channel")).toMatchObject({ pending: false, position: 1 })
    expect(original.getQueryData(communityKeys.server("s1"))).toBe("s1")
  })
  it("confirms category identity while preserving the newer WS row that arrived before POST success", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = createCategory.mutateAsync({ serverId: "s1", name: "New Category", private: true }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain(":New Category:"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:category.create", serverId: "s1", category: { id: "real-category", name: "WS Category", position: 2, private: true } }))
    await act(async () => { resolve({ category: { id: "real-category", name: "New Category", position: 2, private: true } }); await result })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("real-category:WS Category:"))
    expect([...getCommunityDbRegistry(original)!.collections.categories.keys()].some((id) => id.startsWith("tmp_cat_"))).toBe(false)
  })
  it("restores a failed category deletion from native committed state and keeps a newer WS name", async () => {
    const { reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = deleteCategory.mutateAsync({ serverId: "s1", categoryId: "cat1" }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).not.toContain("cat1:"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:category.update", serverId: "s1", categoryId: "cat1", changes: { name: "Newer Category" } }))
    await act(async () => { reject(new Error("nonempty")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("cat1:Newer Category:c1=general"))
  })
  it("confirms a move without losing the newer WS channel name", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = moveChannel.mutateAsync({ serverId: "s1", channelId: "c1", categoryId: "cat2" }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("cat2:Elsewhere:c1=general"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:channel.update", serverId: "s1", channelId: "c1", changes: { name: "newer-room" } }))
    await act(async () => { resolve({ id: "c1", categoryId: "cat2" }); await result })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("cat2:Elsewhere:c1=newer-room"))
  })
  it("confirms channel positions without losing a newer WS name", async () => {
    const { resolve, original } = await mount()
    act(() => projectCommunityWsEventToDb(original, { type: "community:channel.create", serverId: "s1", channel: { id: "c2", name: "second", type: "text", categoryId: "cat1", position: 1, createdAt: "2026-10-02T00:00:00Z" } }))
    let result!: Promise<unknown>; act(() => { result = reorderChannels.mutateAsync({ serverId: "s1", channelIds: ["c2", "c1"] }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("c2=second,c1=general"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:channel.update", serverId: "s1", channelId: "c1", changes: { name: "newer-room" } }))
    await act(async () => { resolve(undefined); await result })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("c2=second,c1=newer-room"))
    expect(getCommunityDbRegistry(original)!.collections.channels.get("c1")?.position).toBe(1)
  })
  it.each(["success", "failure"] as const)("rejects old account update %s without resurrecting old facts or touching B", async (outcome) => {
    const { view, resolve, reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "PATCH")).toBe(true))
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(client).not.toBe(original))
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("original|before"))
    await act(async () => {
      if (outcome === "success") resolve({ name: "old-name", description: "old-description" })
      else reject(new Error("old failure"))
      expect(await result).toMatchObject({ name: "AbortError" })
    })
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(screen.getByTestId("server-detail").textContent).toBe("original|before")
  })
  it("rolls back optimistic leave while keeping newer WS facts", async () => {
    const { reject, original } = await mount()
    const input = { serverId: "s1" }, failure = new Error("denied")
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>; act(() => { result = leave.mutateAsync(input, callbacks).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("server-list").textContent).toBe(""))
    act(() => projectCommunityWsEventToDb(original, { type: "community:server.update", serverId: "s1", changes: { name: "newer-ws" } }))
    await act(async () => { reject(failure); expect(await result).toBe(failure) })
    await waitFor(() => expect(screen.getByTestId("server-list").textContent).toBe("newer-ws"))
    expect(callbacks.onError).toHaveBeenCalledOnce()
    expect(callbacks.onError.mock.calls[0]!.slice(0, 2)).toEqual([failure, input])
    expect(callbacks.onSettled).toHaveBeenCalledOnce()
    expect(callbacks.onSettled.mock.calls[0]!.slice(0, 3)).toEqual([undefined, failure, input])
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })
  it("commits leave through native membership removal and evicts the original server scope", async () => {
    const { resolve, original } = await mount()
    const input = { serverId: "s1" }
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>; act(() => { result = leave.mutateAsync(input, callbacks).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("server-list").textContent).toBe(""))
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(getCommunityDbRegistry(original)!.collections.servers.has("s1")).toBe(false)
    expect(original.getQueryData(communityKeys.servers())).toEqual([])
    expect(callbacks.onSuccess).toHaveBeenCalledOnce()
    expect(callbacks.onSuccess.mock.calls[0]!.slice(0, 2)).toEqual([undefined, input])
    expect(callbacks.onSettled).toHaveBeenCalledOnce()
    expect(callbacks.onSettled.mock.calls[0]!.slice(0, 3)).toEqual([undefined, null, input])
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it("suppresses Leave failure callbacks after scope retirement while the account remains current", async () => {
    const { reject, original } = await mount()
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>; act(() => { result = leave.mutateAsync({ serverId: "s1" }, callbacks).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([path, options]) => path.endsWith("/leave") && options.method === "POST")).toBe(true))
    const registry = getCommunityDbRegistry(original)!
    act(() => retireCommunityChannelReading(registry, "c1", { reason: "read-denied", serverId: "s1" }))
    await act(async () => { reject(new Error("denied after retirement")); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(getCommunityDbRegistry(original)).toBe(registry)
    expect(registry.runtime.lifecycle.get().active).toBe(true)
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSettled).not.toHaveBeenCalled()
  })
  it.each(["success", "failure"] as const)("suppresses retired-account Leave %s callbacks", async (outcome) => {
    const { view, resolve, reject, original } = await mount()
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let result!: Promise<unknown>; act(() => { result = leave.mutateAsync({ serverId: "s1" }, callbacks).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([path, options]) => path.endsWith("/leave") && options.method === "POST")).toBe(true))
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(client).not.toBe(original))
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("old Leave failure")); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSettled).not.toHaveBeenCalled()
  })
  it("retains native detail until one safe route commit after successful owner deletion", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("server-list").textContent).toBe(""))
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(deleteCallbacks.onSuccess).toHaveBeenCalledWith({ serverId: "s1" }, { needsNavigation: true })
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(client, "s1")).toBe(true)
    act(() => { expect(observeOwnerServerDeleteRouteCommit(client, "/c/me")).toEqual(["s1"]); expect(flushOwnerServerDeleteRouteCommit(original)).toEqual(["s1"]) })
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(client, "s1")).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(original)).toEqual([])
  })
  it("reports no new navigation when a safe route commits before owner DELETE success", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true))
    expect(observeOwnerServerDeleteRouteCommit(client, "/c/me")).toEqual([])
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(deleteCallbacks.onSuccess).toHaveBeenCalledWith({ serverId: "s1" }, { needsNavigation: false })
    expect(getCommunityDbRegistry(original)!.collections.servers.has("s1")).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(original)).toEqual([])
  })
  it("restores failed owner DELETE from native committed WS state and cancels route coordination", async () => {
    const { reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true))
    act(() => projectCommunityWsEventToDb(original, { type: "community:server.update", serverId: "s1", changes: { name: "newer-ws" } }))
    await act(async () => { reject(new Error("denied")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => expect(screen.getByTestId("server-list").textContent).toBe("newer-ws"))
    expect(isOwnerServerDeleteRouteProtected(client, "s1")).toBe(false)
    expect(deleteCallbacks.onError).toHaveBeenCalledWith(expect.any(Error), { serverId: "s1" })
  })
  it("holds self-WS deletion at the canonical boundary until the original owner DELETE route commits", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true))
    const runtime = getCommunityRuntime(original)
    act(() => dispatchCommunityWsEvent({ type: "community:server.delete", serverId: "s1" }, { queryClient: original, deliveryMode: "single", communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: "A" }, matchesFocus: () => false, scheduleInboxInvalidate: vi.fn() }))
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(true)
    expect(screen.getByTestId("server-detail").textContent).toBe("original|before")
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    act(() => { observeOwnerServerDeleteRouteCommit(client, "/c/me"); expect(flushOwnerServerDeleteRouteCommit(original)).toEqual(["s1"]) })
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(false)
  })
  it("retains the protected native route across an authoritative empty list refetch during owner DELETE", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true))
    const previous = api.getMockImplementation()!
    api.mockImplementation((path: string, options: unknown) => path === "/api/community/servers" ? Promise.resolve({ servers: [] }) : previous(path, options))
    await act(async () => { await original.refetchQueries({ queryKey: communityKeys.servers(), exact: true }) })
    expect(original.getQueryData(communityKeys.servers())).toEqual([])
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(true)
    expect(screen.getByTestId("server-detail").textContent).toBe("original|before")
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    act(() => { observeOwnerServerDeleteRouteCommit(client, "/c/me"); expect(flushOwnerServerDeleteRouteCommit(original)).toEqual(["s1"]) })
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(false)
  })
  it.each([null, "", "__uncategorized__"])("creates an uncategorized native channel from %s and sends null to the API", async (categoryId) => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = createChannel.mutateAsync({ serverId: "s1", categoryId, name: "Top Level", type: "text" }) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("__uncategorized__::"))
    const post = api.mock.calls.find(([path, options]) => path === "/api/community/channels" && options.method === "POST")!
    expect(JSON.parse(post[1].body)).toEqual({ serverId: "s1", categoryId: null, name: "Top Level", type: "text" })
    await act(async () => { resolve({ channel: { id: "real-top" } }); expect(await result).toEqual({ channel: { id: "real-top" } }) })
    expect(getCommunityDbRegistry(original)!.collections.channels.get("real-top")).toMatchObject({ categoryId: null, pending: false })
  })
  it("does not display a pending channel under a missing named category", async () => {
    const { resolve } = await mount()
    let result!: Promise<unknown>; act(() => { result = createChannel.mutateAsync({ serverId: "s1", categoryId: "missing", name: "Hidden Pending", type: "text" }) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "POST")).toBe(true))
    expect(screen.getByTestId("tree").textContent).not.toContain("Hidden Pending")
    await act(async () => { resolve({ channel: { id: "real-hidden" } }); await result })
  })
  it.each(["channel", "category"] as const)("rolls back failed native %s creation without removing a newer WS row", async (kind) => {
    const { reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = (kind === "channel" ? createChannel.mutateAsync({ serverId: "s1", categoryId: "cat1", name: "Pending", type: "text" }) : createCategory.mutateAsync({ serverId: "s1", name: "Pending" })).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("Pending"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:category.create", serverId: "s1", category: { id: "ws-independent", name: "Independent", position: 2, private: false } }))
    await act(async () => { reject(new Error("denied")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).not.toContain("Pending"))
    expect(screen.getByTestId("tree").textContent).toContain("ws-independent:Independent:")
    const registry = getCommunityDbRegistry(original)!
    expect([...registry.collections.channels.keys(), ...registry.collections.categories.keys()].some((id) => id.startsWith("tmp_"))).toBe(false)
    expect(original.getQueryState(communityKeys.server("s1"))?.fetchStatus).toBe("fetching")
  })
  it("confirms normalized category name without replacing a newer WS position", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = updateCategory.mutateAsync({ serverId: "s1", categoryId: "cat1", name: "Requested" }) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).toContain("cat1:Requested:"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:category.update", serverId: "s1", categoryId: "cat1", changes: { position: 3 } }))
    await act(async () => { resolve({ name: "normalized" }); await result })
    expect(getCommunityDbRegistry(original)!.collections.categories.get("cat1")).toMatchObject({ name: "normalized", position: 3 })
  })
  it("confirms category positions without replacing a newer WS name", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = reorderCategories.mutateAsync({ serverId: "s1", categoryIds: ["cat2", "cat1"] }) })
    await waitFor(() => expect(getCommunityDbRegistry(original)!.collections.categories.get("cat1")?.position).toBe(1))
    act(() => projectCommunityWsEventToDb(original, { type: "community:category.update", serverId: "s1", categoryId: "cat1", changes: { name: "newer-category" } }))
    await act(async () => { resolve(undefined); await result })
    expect(getCommunityDbRegistry(original)!.collections.categories.get("cat1")).toMatchObject({ name: "newer-category", position: 1 })
  })
  it("commits native category deletion without waiting for self-WS", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = deleteCategory.mutateAsync({ serverId: "s1", categoryId: "cat2" }) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).not.toContain("cat2:"))
    await act(async () => { resolve(undefined); await result })
    expect(getCommunityDbRegistry(original)!.collections.categories.has("cat2")).toBe(false)
  })
  it.each(["success", "failure"] as const)("native channel DELETE %s retires unread only after confirmed success", async (outcome) => {
    const { resolve, reject, original } = await mount()
    const projection = getActiveAccountUnreadProjection(original)
    act(() => projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 }))
    let result!: Promise<unknown>; act(() => { result = deleteChannel.mutateAsync({ serverId: "s1", channelId: "c1" }).catch((error) => error) })
    await waitFor(() => expect(screen.getByTestId("tree").textContent).not.toContain("c1=general"))
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("denied")); await result })
    expect(getCommunityDbRegistry(original)!.collections.channels.has("c1")).toBe(outcome === "failure")
    expect(projection.projectUnread("servers", "c1", false)).toBe(outcome === "failure")
  })
  it("publishes the canonical versioned native icon through the original qualified FormData request", async () => {
    const { resolve, original } = await mount()
    const file = new File(["icon"], "icon.png")
    let result!: Promise<unknown>; act(() => { result = icon.mutateAsync({ serverId: "s1", file }) })
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/icon"))).toBe(true))
    const post = api.mock.calls.find(([path]) => path.endsWith("/icon"))!
    expect(post[1]).toMatchObject({ method: "POST", authenticationAccount: "A", assertActive: expect.any(Function) })
    expect(post[1].body.get("file")).toBe(file)
    const url = "/api/community/servers/s1/icon?v=server-icon%2Fs1%2Fnew"
    await act(async () => { resolve({ url }); expect(await result).toEqual({ url }) })
    expect(getCommunityDbRegistry(original)!.collections.servers.get("s1")?.icon).toBe(url)
    expect(original.getQueryData(communityKeys.servers())).toEqual(["s1"])
  })
  it.each([ ["ws", "success"], ["ws", "failure"], ["empty-list", "success"], ["empty-list", "failure"] ] as const)("B %s evicts immediately while A DELETE is held; old A %s has no B or UI effect", async (delivery, outcome) => {
    const { view, resolve, reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = remove.mutateAsync({ serverId: "s1" }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true))
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(client).not.toBe(original))
    await waitFor(() => expect(screen.getByTestId("server-detail").textContent).toBe("original|before"))
    const current = client, runtime = getCommunityRuntime(current)
    if (delivery === "ws") {
      act(() => dispatchCommunityWsEvent({ type: "community:server.delete", serverId: "s1" }, { queryClient: current, deliveryMode: "single", communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: "B" }, matchesFocus: () => false, scheduleInboxInvalidate: vi.fn() }))
    } else {
      const previous = api.getMockImplementation()!
      api.mockImplementation((path: string, options: unknown) => path === "/api/community/servers" ? Promise.resolve({ servers: [] }) : previous(path, options))
      await act(async () => { await current.refetchQueries({ queryKey: communityKeys.servers(), exact: true }) })
    }
    expect(getCommunityDbRegistry(current)!.collections.servers.has("s1")).toBe(false)
    expect(getCommunityDbRegistry(current)!.collections.channels.has("c1")).toBe(false)
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("A old failure")); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(getCommunityDbRegistry(current)!.collections.servers.has("s1")).toBe(false)
    expect(getCommunityDbRegistry(current)!.collections.channels.has("c1")).toBe(false)
    expect(deleteCallbacks.onSuccess).not.toHaveBeenCalled(); expect(deleteCallbacks.onError).not.toHaveBeenCalled()
  })

})
