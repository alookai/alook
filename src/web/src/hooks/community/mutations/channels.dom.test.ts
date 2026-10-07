import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useServerTreeProjection, useChannelRefDirectoryProjection } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import * as commands from "./channels"
import type { ServerDetail } from "../use-servers"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  api.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
})
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
const server = { id: "s1", name: "Studio", discriminator: "0042", description: "", icon: null, ownerId: "viewer" }
const categories: ServerDetail["categories"] = [{ id: "cat_1", name: "General", private: 0, channels: [{ id: "c1", name: "general", active: false, unread: false }, { id: "c2", name: "random", active: false, unread: true }] }, { id: "cat_2", name: "Ideas", private: 0, channels: [] }]
function publish(snapshot: Parameters<typeof publishCommunityLiveSnapshot>[1]["snapshot"]) { publishCommunityLiveSnapshot(client, { snapshot, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } }) }
function seed(cats = categories) {
  publish({ kind: "servers", data: { servers: [server, { ...server, id: "s2", name: "Elsewhere" }].map((row) => ({ ...row, initial: "S", active: false, unread: false, mentions: 0 })) } })
  publish({ kind: "server-detail", data: { ...server, categories: cats } })
  publish({ kind: "server-detail", data: { ...server, id: "s2", categories: [{ id: "other-cat", name: "Other", channels: [{ id: "c3", name: "other", active: false, unread: false }] }] } })
  client.setQueryData(communityKeys.server("s1"), "s1")
  client.setQueryData(communityKeys.channelRefDirectory(), { serverIds: ["s1", "s2"] })
}
function mount<T>(hook: () => T) { return renderHook(() => ({ command: hook(), tree: useServerTreeProjection("s1"), directory: useChannelRefDirectoryProjection() }), { wrapper: Owner }) }
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  api.mockReturnValueOnce(promise)
  return { resolve, reject }
}
function start<T>(command: { mutateAsync: (args: T) => Promise<unknown> }, args: T) { let pending!: Promise<unknown>; act(() => { pending = command.mutateAsync(args).catch((error) => error) }); return pending }
const rename = { serverId: "s1", channelId: "c1", name: "  General Chat  " }
const create = { serverId: "s1", categoryId: "cat_1", name: "  hi  ", type: "text" as const }
const treeChannels = (tree: ServerDetail | null | undefined) => tree?.categories.flatMap((category) => category.channels) ?? []

describe("canonical channel rename", () => {
  it("cancels both exact queries before optimistically updating tree and directory consumers", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useRenameChannel)
    const cancel = vi.spyOn(client, "cancelQueries"), pending = start(rendered.result.current.command, rename)
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).find((row) => row.id === "c1")?.name).toBe("General Chat"))
    expect(rendered.result.current.directory?.[0]?.channels.find((row) => row.id === "c1")?.name).toBe("General Chat")
    for (const key of [communityKeys.server("s1"), communityKeys.channelRefDirectory()]) expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key, exact: true, predicate: expect.any(Function) }))
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[0])
    await act(async () => { held.resolve({ id: "c1", name: "General-Chat" }); await pending })
  })
  it("reconciles both consumers to the PATCH response normalized name", async () => {
    seed(); api.mockResolvedValueOnce({ id: "c1", name: "General-Chat" })
    const rendered = mount(commands.useRenameChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync(rename) })
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).find((row) => row.id === "c1")?.name).toBe("General-Chat"))
    expect(rendered.result.current.directory?.[0]?.channels.find((row) => row.id === "c1")?.name).toBe("General-Chat")
    expect(client.getQueryData(communityKeys.server("s1"))).toBe("s1")
    expect(registry.collections.channels.get("c3")?.name).toBe("other")
  })
  it("restores both consumers on failure without optimistic residue", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useRenameChannel), pending = start(rendered.result.current.command, rename)
    await waitFor(() => expect(registry.collections.channels.get("c1")?.name).toBe("General Chat"))
    await act(async () => { held.reject(new Error("duplicate")); expect(await pending).toMatchObject({ message: "duplicate" }) })
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).find((row) => row.id === "c1")?.name).toBe("general"))
    expect(rendered.result.current.directory?.[0]?.channels.find((row) => row.id === "c1")?.name).toBe("general")
  })
  it.each(["success", "error"] as const)("invalidates only original exact tree and directory after %s", async (outcome) => {
    seed(); if (outcome === "success") api.mockResolvedValueOnce({ id: "c1", name: "renamed" }); else api.mockRejectedValueOnce(new Error("boom"))
    client.setQueryData(communityKeys.server("s2"), "s2")
    const rendered = mount(commands.useRenameChannel), invalidate = vi.spyOn(client, "invalidateQueries")
    await act(async () => { await rendered.result.current.command.mutateAsync(rename).catch(() => {}) })
    for (const key of [communityKeys.server("s1"), communityKeys.channelRefDirectory()]) expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key, exact: true, predicate: expect.any(Function) }))
    expect(client.getQueryState(communityKeys.server("s2"))?.isInvalidated).toBe(false)
  })
  it("leaves present canonical facts and transports unchanged when the channel is missing", async () => {
    seed(); api.mockResolvedValueOnce({ id: "missing", name: "renamed" })
    const before = registry.collections.channels.get("c1"), directory = client.getQueryData(communityKeys.channelRefDirectory()), rendered = mount(commands.useRenameChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync({ ...rename, channelId: "missing" }) })
    expect(registry.collections.channels.get("c1")).toBe(before)
    expect(registry.collections.channels.has("missing")).toBe(false)
    expect(client.getQueryData(communityKeys.channelRefDirectory())).toBe(directory)
  })
})

describe("canonical channel move and create", () => {
  it.each(["cat_2", null])("PATCHes categoryId %s and invalidates the original tree and directory", async (categoryId) => {
    seed(); api.mockResolvedValueOnce(undefined)
    const rendered = mount(commands.useMoveChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync({ serverId: "s1", channelId: "c1", categoryId }) })
    expect(api).toHaveBeenCalledWith("/api/community/channels/c1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ categoryId }) }))
    expect(registry.collections.channels.get("c1")?.categoryId).toBe(categoryId)
    for (const key of [communityKeys.server("s1"), communityKeys.channelRefDirectory()]) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })
  it("inserts a pending channel into the matching category", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useCreateChannel), pending = start(rendered.result.current.command, create)
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).find((row) => row.pending)).toMatchObject({ name: "hi", type: "text" }))
    const row = treeChannels(rendered.result.current.tree).find((row) => row.pending)!
    expect(row.id).toMatch(/^tmp_ch_/)
    await act(async () => { held.resolve({ channel: { id: "ch_real" } }); await pending })
  })
  it("physically cancels an in-flight server refetch before the optimistic write", async () => {
    seed()
    let signal!: AbortSignal
    const read = client.query({ queryKey: communityKeys.server("s1"), staleTime: 0, queryFn: (context) => { signal = context.signal; return new Promise<string>(() => {}) } }).catch((error) => error)
    const held = deferred(), rendered = mount(commands.useCreateChannel), pending = start(rendered.result.current.command, create)
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).some((row) => row.pending)).toBe(true))
    expect(signal.aborted).toBe(true)
    await act(async () => { held.resolve({ channel: { id: "ch_real" } }); await pending; await read })
  })
  it("leaves existing categories unchanged when the target category is absent", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useCreateChannel), pending = start(rendered.result.current.command, { ...create, categoryId: "missing" })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(treeChannels(rendered.result.current.tree).map((row) => row.id)).toEqual(["c1", "c2"])
    expect(registry.collections.categories.has("missing")).toBe(false)
    await act(async () => { held.reject(new Error("invalid category")); await pending })
    expect(registry.collections.channels.size).toBe(3)
  })
  it("rolls back a pending channel on failure", async () => {
    seed(); api.mockRejectedValueOnce(new Error("boom"))
    const rendered = mount(commands.useCreateChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync(create).catch(() => {}) })
    await waitFor(() => expect(treeChannels(rendered.result.current.tree).map((row) => row.id)).toEqual(["c1", "c2"]))
    expect(Array.from(registry.collections.channels.values()).some((row) => row.pending)).toBe(false)
  })
  it("swaps the temp id to the real id and clears pending on success", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useCreateChannel), pending = start(rendered.result.current.command, create)
    await waitFor(() => expect(Array.from(registry.collections.channels.values()).some((row) => row.pending)).toBe(true))
    const temp = Array.from(registry.collections.channels.values()).find((row) => row.pending)!.id
    await act(async () => { held.resolve({ channel: { id: "ch_real", name: "normalized", position: 8 } }); await pending })
    expect(registry.collections.channels.has(temp)).toBe(false)
    expect(registry.collections.channels.get("ch_real")).toMatchObject({ name: "normalized", pending: false, position: 8 })
  })
  it.each(["success", "failure"] as const)("invalidates the original server tree on create %s", async (outcome) => {
    seed(); if (outcome === "success") api.mockResolvedValueOnce({ channel: { id: "ch_real" } }); else api.mockRejectedValueOnce(new Error("boom"))
    const rendered = mount(commands.useCreateChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync(create).catch(() => {}) })
    expect(client.getQueryState(communityKeys.server("s1"))?.isInvalidated).toBe(true)
  })
  it("POSTs type, serverId, categoryId and original name to the unified create door", async () => {
    seed(); api.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const rendered = mount(commands.useCreateChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync(create) })
    expect(api).toHaveBeenCalledWith("/api/community/channels", expect.objectContaining({ method: "POST" }))
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual(create)
  })
  it.each(["", UNCATEGORIZED_CATEGORY_ID, null])("creates one derived uncategorized bucket and sends null for categoryId %s", async (categoryId) => {
    seed(); const held = deferred(), rendered = mount(commands.useCreateChannel), pending = start(rendered.result.current.command, { ...create, categoryId })
    await waitFor(() => expect(rendered.result.current.tree?.categories.find((row) => row.id === UNCATEGORIZED_CATEGORY_ID)?.channels[0]).toMatchObject({ pending: true, name: "hi" }))
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ ...create, categoryId: null })
    await act(async () => { held.resolve({ channel: { id: "ch_real" } }); await pending })
    expect(rendered.result.current.tree?.categories.filter((row) => row.id === UNCATEGORIZED_CATEGORY_ID)).toHaveLength(1)
  })
  it("reuses the canonical uncategorized projection without a duplicate category", async () => {
    seed([...categories, { id: UNCATEGORIZED_CATEGORY_ID, name: "", channels: [{ id: "top", name: "Top", active: false, unread: false }] }])
    api.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const rendered = mount(commands.useCreateChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync({ ...create, categoryId: "" }) })
    await waitFor(() => expect(rendered.result.current.tree?.categories.find((row) => row.id === UNCATEGORIZED_CATEGORY_ID)?.channels.map((row) => row.id)).toEqual(["top", "ch_real"]))
    expect(rendered.result.current.tree?.categories.filter((row) => row.name === "")).toHaveLength(1)
    expect(registry.collections.categories.has(UNCATEGORIZED_CATEGORY_ID)).toBe(false)
  })
})

describe("canonical category commands and channel deletion", () => {
  it("appends a pending category with a tmp_cat_ id", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useCreateCategory), pending = start(rendered.result.current.command, { serverId: "s1", name: "  New Ideas  " })
    await waitFor(() => expect(rendered.result.current.tree?.categories.find((row) => row.pending)).toMatchObject({ name: "New Ideas" }))
    expect(rendered.result.current.tree?.categories.find((row) => row.pending)?.id).toMatch(/^tmp_cat_/)
    await act(async () => { held.resolve({ category: { id: "cat_real" } }); await pending })
  })
  it("swaps the temp category id to the real id and clears pending", async () => {
    seed(); api.mockResolvedValueOnce({ category: { id: "cat_real" } })
    const rendered = mount(commands.useCreateCategory)
    await act(async () => { await rendered.result.current.command.mutateAsync({ serverId: "s1", name: "New Ideas" }) })
    expect(registry.collections.categories.get("cat_real")).toMatchObject({ name: "New Ideas", pending: false })
    expect(Array.from(registry.collections.categories.values()).some((row) => row.id.startsWith("tmp_cat_"))).toBe(false)
  })
  it("rolls back category creation on failure", async () => {
    seed(); api.mockRejectedValueOnce(new Error("boom"))
    const rendered = mount(commands.useCreateCategory)
    await act(async () => { await rendered.result.current.command.mutateAsync({ serverId: "s1", name: "New Ideas" }).catch(() => {}) })
    await waitFor(() => expect(rendered.result.current.tree?.categories.map((row) => row.id)).toEqual(["cat_1", "cat_2"]))
  })
  it("retires projected unread after a successful DELETE without waiting for self WS", async () => {
    seed(); const projection = getActiveAccountUnreadProjection(client)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    api.mockResolvedValueOnce(undefined)
    const rendered = mount(commands.useDeleteChannel)
    await act(async () => { await rendered.result.current.command.mutateAsync({ serverId: "s1", channelId: "c1" }) })
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("inbox-unreads", "c1", true, 1)).toBe(false)
    expect(registry.collections.channels.has("c1")).toBe(false)
  })
  it("keeps projected unread when DELETE fails", async () => {
    seed(); const projection = getActiveAccountUnreadProjection(client)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    api.mockRejectedValueOnce(new Error("500"))
    const rendered = mount(commands.useDeleteChannel)
    await act(async () => { await expect(rendered.result.current.command.mutateAsync({ serverId: "s1", channelId: "c1" })).rejects.toThrow("500") })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-unreads", "c1", true, 1)).toBe(true)
    expect(registry.collections.channels.has("c1")).toBe(true)
  })
  it("removes a category optimistically", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useDeleteCategory), pending = start(rendered.result.current.command, { serverId: "s1", categoryId: "cat_2" })
    await waitFor(() => expect(rendered.result.current.tree?.categories.map((row) => row.id)).toEqual(["cat_1"]))
    await act(async () => { held.resolve(undefined); await pending })
  })
  it("restores the category on a rejected non-empty delete", async () => {
    seed(); const held = deferred(), rendered = mount(commands.useDeleteCategory), pending = start(rendered.result.current.command, { serverId: "s1", categoryId: "cat_2" })
    await waitFor(() => expect(registry.collections.categories.has("cat_2")).toBe(false))
    await act(async () => { held.reject(new Error("Move or delete its channels first")); await pending })
    await waitFor(() => expect(rendered.result.current.tree?.categories.map((row) => row.id)).toEqual(["cat_1", "cat_2"]))
  })
  it("sends the category name update and publishes it without self WS", async () => {
    seed(); api.mockResolvedValueOnce(undefined)
    const rendered = mount(commands.useUpdateCategory)
    await act(async () => { await rendered.result.current.command.mutateAsync({ serverId: "s1", categoryId: "cat_1", name: "Renamed" }) })
    expect(api).toHaveBeenCalledWith("/api/community/servers/s1/categories/cat_1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }))
    expect(registry.collections.categories.get("cat_1")?.name).toBe("Renamed")
  })
})
