import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { ingestServers, ingestServerDetail, captureCommunityLiveSnapshotToken, publishCommunityCreatedChannel } from "@/lib/community-db/sync"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import { useServer, useServers } from "../use-servers"
import { createOwnerServerDeleteRouteToken, observeOwnerServerDeleteRouteCommit, claimOwnerServerDeleteNavigation, claimOwnerServerDeleteScopeFlush, isOwnerServerDeleteRouteProtected } from "@/lib/community/eject-server"
import { flushOwnerServerDeleteRouteCommit } from "../community-ws/scope-eviction"
import { useLeaveServer, useDeleteServer, useUpdateServer, useCreateServer, useUploadServerIcon } from "./servers"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
beforeEach(() => { api.mockReset() })

function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup() {
  const owner = await createCommunityQueryOwner()
  const servers = [
    { id: "srv_1", name: "old", description: "d", initial: "O", active: false, unread: false, mentions: 0, ownerId: "viewer", isOwner: true },
    { id: "srv_2", name: "untouched", description: "unchanged description", initial: "U", active: false, unread: false, mentions: 4, ownerId: "viewer", isOwner: true },
  ]
  ingestServers(owner.registry, { servers })
  ingestServerDetail(owner.registry, { id: "srv_1", name: "old", discriminator: "", description: "d", icon: null, ownerId: "viewer", categories: [] })
  owner.client.setQueryData(communityKeys.servers(), ["srv_1", "srv_2"])
  owner.client.setQueryData(communityKeys.server("srv_1"), "srv_1")
  owner.client.setQueryData(communityKeys.channelRefDirectory(), { servers: [] })
  const held = deferred(), routeToken = createOwnerServerDeleteRouteToken(owner.client), onSuccess = vi.fn(), onError = vi.fn()
  let remote: Array<typeof servers[number] & { icon?: string | null }> = servers
  api.mockImplementation((path: string, options?: { method?: string; body?: string }) => {
    if (options?.method) return held.promise.then((value) => {
      if (options.method === "PATCH") { const fields = JSON.parse(options.body!); remote = remote.map((server) => server.id === "srv_1" ? { ...server, ...fields } : server); return fields }
      if (path.endsWith("/icon")) remote = remote.map((server) => server.id === "srv_1" ? { ...server, icon: (value as { url: string }).url } : server)
      if (options.method === "DELETE" || path.endsWith("/leave")) remote = remote.filter((server) => server.id !== "srv_1")
      return value
    })
    if (path.endsWith("/categories")) return Promise.resolve({ categories: [] })
    if (path.endsWith("/channels")) return Promise.resolve({ channels: [] })
    return Promise.resolve({ servers: remote.map((server) => ({ ...server, role: "owner", discriminator: "", icon: server.icon ?? null })) })
  })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const view = renderHook(({ detailActive }) => ({ leave: useLeaveServer(), remove: useDeleteServer({ routeToken, onSuccess, onError }), update: useUpdateServer(), create: useCreateServer(), icon: useUploadServerIcon(), rail: useServers(), detail: useServer(detailActive ? "srv_1" : null) }), { wrapper, initialProps: { detailActive: true } })
  await waitFor(() => { expect(view.result.current.rail.servers).toHaveLength(2); expect(view.result.current.detail.server?.name).toBe("old") })
  return { ...owner, held, view, routeToken, onSuccess, onError }
}
type View = Awaited<ReturnType<typeof setup>>
async function begin(view: View, operation: "leave" | "remove") {
  let request!: Promise<unknown>
  act(() => { request = view.view.result.current[operation].mutateAsync({ serverId: "srv_1" }).catch((error) => error) })
  await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method)).toBe(true))
  return { request }
}
function seedPrivateScope(view: View) {
  for (const channel of [{ id: "private_parent", name: "Private parent", type: "text" as const, parentChannelId: null, parentMessageId: null }, { id: "private_child", name: "Private title", type: "thread" as const, parentChannelId: "private_parent", parentMessageId: "private_opener" }]) publishCommunityCreatedChannel(view.client, { ...channel, serverId: "srv_1", categoryId: null, creatorId: "viewer", position: 0, archived: false, muted: false, unread: false, tags: [], pending: false }, { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined })
  view.runtime.ui.actions.setCurrentServerId("srv_1")
  view.runtime.ui.actions.setCurrentChannelId("private_child")
  view.runtime.messageStream.actions.dispatch({ kind: "channel", id: "private_child", serverId: "srv_1" }, { type: "wsMessage", message: { id: "message_1", type: "chat", authorId: "user_1", authorName: "User", content: "Private content" } })
}

describe("Native server membership commands", () => {
  it("fences every unread source in the departing scope and rolls back atomically", async () => {
    const view = await setup(), projection = getActiveAccountUnreadProjection(view.client)
    projection.recordArrival({ channelId: "c1", serverId: "srv_1", seq: 1 })
    projection.recordArrival({ channelId: "c2", serverId: "srv_2", seq: 1 })
    const { request } = await begin(view, "leave")
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("servers", "c2", false)).toBe(true)
    await act(async () => { view.held.reject(new Error("failed")); await request })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })
  it.each(["leave", "remove"] as const)("%s hides the rail row optimistically and restores it on failure", async (operation) => {
    const view = await setup(), { request } = await begin(view, operation)
    await waitFor(() => expect(view.view.result.current.rail.servers.map(({ id }) => id)).toEqual(["srv_2"]))
    await act(async () => { view.held.reject(new Error("boom")); await request })
    await waitFor(() => expect(view.view.result.current.rail.servers.map(({ id }) => id)).toEqual(["srv_1", "srv_2"]))
  })
  it.each(["leave", "remove"] as const)("%s success clears the server subtree, stream and private route", async (operation) => {
    const view = await setup(); act(() => seedPrivateScope(view))
    expect(view.registry.collections.channels.get("private_child")?.name).toBe("Private title")
    const { request } = await begin(view, operation)
    view.view.rerender({ detailActive: false })
    await act(async () => { view.held.resolve(); await request })
    if (operation === "remove") {
      expect(view.runtime.ui.get().currentServerId).toBe("srv_1")
      expect(observeOwnerServerDeleteRouteCommit(view.client, "/c/me")).toEqual(["srv_1"])
      act(() => expect(flushOwnerServerDeleteRouteCommit(view.client)).toEqual(["srv_1"]))
    }
    expect(view.runtime.ui.get()).toMatchObject({ currentServerId: null, currentChannelId: null })
    expect(view.registry.collections.channels.has("private_child")).toBe(false)
    expect(view.client.getQueryState(communityKeys.server("srv_1"))).toBeUndefined()
    expect([...view.runtime.messageStream.get().entries.values()].some((entry) => entry.scope.serverId === "srv_1")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(false)
  })
})

describe("Native owner-delete navigation lifecycle", () => {
  it("reports zero navigation and flushes once after a safe route committed before success", async () => {
    const view = await setup(), { request } = await begin(view, "remove")
    view.view.rerender({ detailActive: false })
    expect(observeOwnerServerDeleteRouteCommit(view.client, "/c/me")).toEqual([])
    expect(flushOwnerServerDeleteRouteCommit(view.client)).toEqual([])
    expect(view.client.getQueryState(communityKeys.server("srv_1"))).toBeDefined()
    const removeQueries = vi.spyOn(view.client, "removeQueries")
    await act(async () => { view.held.resolve(); await request })
    expect(view.client.getQueryState(communityKeys.server("srv_1"))).toBeUndefined()
    expect(view.onSuccess).toHaveBeenCalledWith({ serverId: "srv_1" }, { needsNavigation: false })
    const count = removeQueries.mock.calls.length
    expect(count).toBeGreaterThan(0)
    expect(flushOwnerServerDeleteRouteCommit(view.client)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(count)
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1", view.routeToken)).toBe(true)
  })
  it("requests one navigation while the deleted route remains committed", async () => {
    const view = await setup(), { request } = await begin(view, "remove")
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(true)
    await act(async () => { view.held.resolve(); await request })
    expect(view.onSuccess).toHaveBeenCalledWith({ serverId: "srv_1" }, { needsNavigation: true })
    expect(claimOwnerServerDeleteNavigation(view.client, "srv_1", view.routeToken, "/c/me")).toBe(true)
    expect(claimOwnerServerDeleteNavigation(view.client, "srv_1", view.routeToken, "/c/me")).toBe(false)
    view.view.rerender({ detailActive: false })
    expect(observeOwnerServerDeleteRouteCommit(view.client, "/c/me")).toEqual(["srv_1"])
    act(() => expect(flushOwnerServerDeleteRouteCommit(view.client)).toEqual(["srv_1"]))
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1", view.routeToken)).toBe(true)
  })
  it("restores membership and clears coordination before reporting DELETE failure", async () => {
    const view = await setup(), { request } = await begin(view, "remove"), failure = new Error("failed")
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(true)
    await act(async () => { view.held.reject(failure); await request })
    await waitFor(() => expect(view.view.result.current.rail.servers.map(({ id }) => id)).toEqual(["srv_1", "srv_2"]))
    expect(view.onError).toHaveBeenCalledWith(failure, { serverId: "srv_1" })
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(view.client, "srv_1", view.routeToken)).toBe(false)
    observeOwnerServerDeleteRouteCommit(view.client, "/c/me")
    expect(claimOwnerServerDeleteScopeFlush(view.client, "srv_1")).toBe(false)
  })
})

describe("Native server field commands", () => {
  it("restores the canonical detail and rail on PATCH failure", async () => {
    const view = await setup(); let request!: Promise<unknown>
    act(() => { request = view.view.result.current.update.mutateAsync({ serverId: "srv_1", name: "new", description: "d2" }).catch((error) => error) })
    await waitFor(() => { expect(view.view.result.current.detail.server?.name).toBe("new"); expect(view.view.result.current.rail.servers[0]?.name).toBe("new") })
    await act(async () => { view.held.reject(new Error("boom")); await request })
    await waitFor(() => { expect(view.view.result.current.detail.server?.name).toBe("old"); expect(view.view.result.current.rail.servers[0]).toMatchObject({ name: "old", description: "d" }) })
  })
  it("aligns optimistic detail and rail while preserving the unrelated server", async () => {
    const view = await setup(), untouched = view.registry.collections.servers.get("srv_2"); let request!: Promise<unknown>
    act(() => { request = view.view.result.current.update.mutateAsync({ serverId: "srv_1", name: "new", description: "new description" }) })
    await waitFor(() => { expect(view.view.result.current.detail.server?.name).toBe("new"); expect(view.view.result.current.rail.servers[0]).toMatchObject({ name: "new", description: "new description", initial: "N" }) })
    expect(view.registry.collections.servers.get("srv_2")).toBe(untouched)
    await act(async () => { view.held.resolve(); await request })
    await waitFor(() => expect(view.view.result.current.detail.server).toMatchObject({ name: "new", description: "new description" }))
    expect(view.registry.collections.servers.get("srv_2")).toMatchObject({ name: "untouched", description: "unchanged description", mentions: 4 })
  })
  it("invalidates the original channel-ref directory after settling", async () => {
    const view = await setup(); let request!: Promise<unknown>
    act(() => { request = view.view.result.current.update.mutateAsync({ serverId: "srv_1", name: "new", description: "updated" }) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true))
    await act(async () => { view.held.resolve(); await request })
    expect(view.client.getQueryState(communityKeys.channelRefDirectory())?.isInvalidated).toBe(true)
  })
  it("invalidates the actual server rail after create success", async () => {
    const view = await setup(); let request!: Promise<unknown>
    act(() => { request = view.view.result.current.create.mutateAsync({ name: "n" }) })
    await waitFor(() => expect(api.mock.calls.some(([path, options]) => path === "/api/community/servers" && options?.method === "POST")).toBe(true))
    await act(async () => { view.held.resolve({ server: { id: "srv_new" } }); await request })
    await waitFor(() => expect(api.mock.calls.some(([path, options]) => path === "/api/community/servers" && !options?.method)).toBe(true))
  })
  it("publishes the same canonical versioned icon to detail and rail", async () => {
    const view = await setup(), file = new File(["icon"], "icon.png", { type: "image/png" }); let request!: Promise<unknown>
    act(() => { request = view.view.result.current.icon.mutateAsync({ serverId: "srv_1", file }) })
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === "/api/community/servers/srv_1/icon")).toBe(true))
    const url = "/api/community/servers/srv_1/icon?v=server-icon%2Fsrv_1%2Fobject-one"
    await act(async () => { view.held.resolve({ url }); await request })
    await waitFor(() => { expect(view.view.result.current.detail.server?.icon).toBe(url); expect(view.view.result.current.rail.servers[0]?.icon).toBe(url) })
    const options = api.mock.calls.find(([path]) => path.endsWith("/icon"))![1]
    expect(options.body.get("file")).toBe(file)
    expect(options.authenticationAccount).toBe("viewer")
  })
})
