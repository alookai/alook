import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider, CancelledError } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishAccountAttentionSnapshot, publishCommunityLiveSnapshot, projectCommunityWsEventToDb, publishCommunityChannelDirectory } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import { AccountUnreadProjection, getActiveAccountUnreadProjection } from "./account-unread-projection"
import { serversQueryFn, serversProjectedQueryFn, serverProjectedQueryFn, useServers, useServer, useViewerServerRole, type ServersResponse, type ServerDetail } from "./use-servers"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  apiFetchMock.mockReset()
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
const identity = { id: "srv_1", name: "Alook", discriminator: "0001", description: "Build together", icon: null, ownerId: "viewer" }
const canonical = (id = "srv_1") => ({ ...identity, id, initial: "A", active: false, unread: false, mentions: 0, isOwner: false })
function publish(snapshot: Parameters<typeof publishCommunityLiveSnapshot>[1]["snapshot"]) {
  return publishCommunityLiveSnapshot(client, { snapshot, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
}
function seedList(servers = [canonical()]) {
  publish({ kind: "servers", data: { servers } })
  client.setQueryData(communityKeys.servers(), servers.map((server) => server.id))
}
function seedDetail(channels: ServerDetail["categories"][number]["channels"] = []) {
  seedList()
  publish({ kind: "server-detail", data: { ...identity, categories: [{ id: "cat_1", name: "Main", private: 0, channels }] } })
  client.setQueryData(communityKeys.server(identity.id), identity.id)
}
function attention(channelId: string, count = 1, parentChannelId: string | null = null) {
  publishAccountAttentionSnapshot(client, {
    snapshot: { scopes: [{ scopeId: channelId, channelId, serverId: identity.id, parentChannelId, ordinaryUnread: true, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: count }], items: [], limit: 100, truncated: false },
    proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined },
  })
}
function fetchList(projection = getActiveAccountUnreadProjection(client)) {
  return client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(projection, client), staleTime: 0 })
}
function fetchDetail() {
  return client.query({ queryKey: communityKeys.server(identity.id), queryFn: ({ signal }) => serverProjectedQueryFn(client, identity.id, signal)(), staleTime: 0 })
}
function detailApi(url: string) {
  if (url === "/api/community/servers") return { servers: [identity] }
  if (url.endsWith("/categories")) return { categories: [{ id: "cat_1", name: "Main", private: 0 }] }
  if (url.endsWith("/channels")) return { channels: [] }
  throw new Error("unexpected " + url)
}
async function rawList() {
  let result!: ServersResponse
  await client.query({ queryKey: ["server-transform"], queryFn: async (context) => {
    result = await serversQueryFn(context)
    return result.servers.map((server) => server.id)
  } })
  return result
}

describe("useServers / serversQueryFn", () => {
  it("materialises raw server rows into render-ready Server shape", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [{ ...identity, official: true, role: "owner", mentions: 3, unread: true }, { ...identity, id: "srv_2", name: "Beta", discriminator: "12345", role: "member", description: undefined }] })
    const data = await rawList()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(data.servers[0]).toMatchObject({ ...identity, official: true, initial: "A", isOwner: true, mentions: 3, active: false, unread: true })
    expect(data.servers[1]).toMatchObject({ official: false, mentions: 0, isOwner: false, unread: false, description: "" })
    expect(client.getQueryData(["server-transform"])).toEqual(["srv_1", "srv_2"])
  })

  it("preserves mentions when provided; defaults to 0 when omitted", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [{ ...identity, mentions: 7 }, { ...identity, id: "srv_2" }] })
    expect((await rawList()).servers.map((server) => server.mentions)).toEqual([7, 0])
  })

  it("passes TanStack's abort signal to the canonical request", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    let signal!: AbortSignal
    await client.query({ queryKey: communityKeys.servers(), queryFn: async (context) => { signal = context.signal; return (await serversQueryFn(context)).servers.map((server) => server.id) } })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", expect.objectContaining({ signal, assertActive: expect.any(Function) }))
  })

  it("populates queryClient at communityKeys.servers() with transport IDs only", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [identity] })
    await fetchList()
    expect(client.getQueryData(communityKeys.servers())).toEqual([identity.id])
    expect(registry.collections.servers.get(identity.id)).toMatchObject(identity)
  })

  it("uses a complete server list as authoritative unread negative evidence", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const projection = getActiveAccountUnreadProjection(client)
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })
    await fetchList(projection)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("cancels server-list snapshot coverage when the transport fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
    const projection = getActiveAccountUnreadProjection(client)
    await expect(fetchList(projection)).rejects.toThrow("offline")
    expect(projection.inspectForTests().pendingSnapshots).toBe(0)
  })

  it("rejects a server-list response captured for an earlier account epoch", async () => {
    let release!: (value: { servers: typeof identity[] }) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const projection = getActiveAccountUnreadProjection(client)
    const pending = fetchList(projection)
    const result = pending.catch((error) => error)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    registry.runtime.ws.actions.activateProfileAccount("replacement")
    release({ servers: [identity] })
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(projection.inspectForTests().pendingSnapshots).toBe(0)
    expect(registry.collections.servers.size).toBe(0)
  })

  it("confirms live list authority only for the current QueryClient and auth generation", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    expect(rendered.result.current.isLiveAuthoritative).toBe(false)
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(true))
    act(() => registry.runtime.ws.actions.activateProfileAccount("replacement"))
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(false))
    rendered.unmount()
    const other = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const otherRegistry = createCommunityDbRegistry(other, "viewer")
    await otherRegistry.preload()
    apiFetchMock.mockReturnValueOnce(new Promise(() => {}))
    function OtherOwner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client: other }, createElement(CommunityDbProvider, { registry: otherRegistry }, children)) }
    const replacement = renderHook(() => useServers(), { wrapper: OtherOwner })
    expect(replacement.result.current.isLiveAuthoritative).toBe(false)
    replacement.unmount(); await other.cancelQueries(); await otherRegistry.cleanup(); other.clear()
  })

  it("invalidates live list authority when the access epoch changes", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(true))
    act(() => registry.runtime.ws.actions.revokeServerAccess("s1"))
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(false))
  })

  it("binds live authority to the projected unordered server membership", async () => {
    const servers = Array.from({ length: 7 }, (_, index) => ({ ...canonical("s" + (index + 1)), name: "Server " + (index + 1) }))
    apiFetchMock.mockResolvedValueOnce({ servers })
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(true))
    expect(rendered.result.current.servers.map((server) => server.id)).toEqual(servers.map((server) => server.id))
    act(() => client.setQueryData(communityKeys.servers(), [...servers.map((server) => server.id)].reverse()))
    expect(rendered.result.current.isLiveAuthoritative).toBe(true)
    act(() => publish({ kind: "servers", data: { servers: servers.slice(0, 6) } }))
    await waitFor(() => expect(rendered.result.current.servers).toHaveLength(6))
    expect(rendered.result.current.isLiveAuthoritative).toBe(false)
    apiFetchMock.mockResolvedValueOnce({ servers })
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.isLiveAuthoritative).toBe(true))
    act(() => publish({ kind: "servers", data: { servers: [...servers, canonical("s8")] } }))
    await waitFor(() => expect(rendered.result.current.servers).toHaveLength(8))
    expect(rendered.result.current.isLiveAuthoritative).toBe(false)
  })

  it("does not confirm live list authority after a transport failure", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ message: "offline" }))
    expect(rendered.result.current.isLiveAuthoritative).toBe(false)
  })

  it("correlates cold rail unread sources with their attention facets", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [{ ...identity, unreadSources: [{ channelId: "attention", lastUnreadSeq: 10 }, { channelId: "ordinary", lastUnreadSeq: 3 }], mentionSources: [{ channelId: "attention", count: 1, lastSeq: 5 }, { channelId: "ignored", count: 0, lastSeq: 99 }] }] })
    const projection = new AccountUnreadProjection("viewer")
    projection.setNotificationPolicy({ server: { srv_1: "mentions" } })
    await fetchList(projection)
    expect(projection.projectUnread("servers", "attention", false)).toBe(true)
    expect(projection.projectUnread("servers", "ordinary", false)).toBe(false)
    expect(projection.projectUnread("servers", "ignored", false)).toBe(false)
    projection.recordRead("attention", 5)
    expect(projection.projectUnread("servers", "attention", false)).toBe(false)
  })

  it("does not let the legacy unread ledger override canonical attention", async () => {
    seedList([canonical(), { ...canonical("s2"), unread: true, mentions: 2 }, { ...canonical("s3"), unread: true }])
    getActiveAccountUnreadProjection(client).recordArrival({ channelId: "c1", serverId: identity.id, seq: 1 })
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.servers).toHaveLength(3))
    expect(rendered.result.current.servers.map(({ unread, mentions }) => ({ unread, mentions }))).toEqual(Array.from({ length: 3 }, () => ({ unread: false, mentions: 0 })))
  })

  it("projects live mention-source evidence onto canonical rail rows", async () => {
    seedList(); attention("c1")
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.servers[0]).toMatchObject({ id: identity.id, unread: true, mentions: 1 }))
  })

  it("returns the frozen empty server list before query data arrives", () => {
    apiFetchMock.mockReturnValueOnce(new Promise(() => {}))
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    const first = rendered.result.current.servers
    rendered.rerender()
    expect(rendered.result.current.servers).toBe(first)
    expect(first).toEqual([])
  })

  it("does not retain a legacy rail unread without canonical attention", async () => {
    seedList([{ ...canonical(), unread: true }])
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.servers[0]?.unread).toBe(false))
    act(() => seedList())
    await waitFor(() => expect(rendered.result.current.servers[0]?.unread).toBe(false))
  })

  it("keeps legacy rail source transitions subordinate to canonical attention", async () => {
    seedList([{ ...canonical(), unread: true }])
    const rendered = renderHook(() => useServers(), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.servers[0]?.unread).toBe(false))
    act(() => publish({ kind: "servers", data: { servers: [{ ...canonical(), unread: true, unreadSources: [{ channelId: "c1", lastUnreadSeq: 4 }] }] } }))
    await waitFor(() => expect(rendered.result.current.servers[0]?.unread).toBe(false))
    act(() => getActiveAccountUnreadProjection(client).acceptPrimarySnapshot({ revision: 1, readStates: [{ channelId: "c1", lastReadSeq: 4 }] }))
    expect(rendered.result.current.servers[0]?.unread).toBe(false)
  })
})

describe("useServer / projected canonical detail", () => {
  it("retains a current server deadline failure across another native consumer and recovers on explicit retry", async () => {
    seedList()
    const key = communityKeys.server(identity.id)
    client.setQueryDefaults(key, { retry: 1, retryDelay: 0 })
    let categorySignal!: AbortSignal
    apiFetchMock.mockImplementation((url: string, options: { signal: AbortSignal }) => url.endsWith("/categories")
      ? new Promise(() => { categorySignal = options.signal }) : Promise.resolve(detailApi(url)))
    vi.useFakeTimers()
    const first = renderHook(() => useServer(identity.id), { wrapper: Owner })
    let second: ReturnType<typeof renderHook> | undefined
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(categorySignal).toBeDefined()
      const originalQuery = client.getQueryCache().find({ queryKey: key, exact: true })!
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100) })
      expect(first.result.current.isError).toBe(true)
      expect(first.result.current.fetchStatus).toBe("idle")
      expect(categorySignal.aborted).toBe(true)
      expect(originalQuery.state.fetchFailureCount).toBe(1)
      second = renderHook(() => useServer(identity.id), { wrapper: Owner })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(first.result.current.isError).toBe(true)
      expect(first.result.current.fetchStatus).toBe("idle")
      expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(originalQuery)
      expect(apiFetchMock.mock.calls.filter(([path]) => String(path).endsWith("/categories"))).toHaveLength(1)
      apiFetchMock.mockImplementation((url: string) => Promise.resolve(detailApi(url)))
      await act(async () => { await first.result.current.refetch() })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(first.result.current.server?.id).toBe(identity.id)
      expect(first.result.current.isError).toBe(false)
      expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(originalQuery)
      expect(apiFetchMock.mock.calls.filter(([path]) => String(path).endsWith("/categories"))).toHaveLength(2)
    } finally {
      second?.unmount()
      first.unmount()
      vi.useRealTimers()
    }
  })

  it.each([403, 404])("hides retained server detail after a definitive %s", async (status) => {
    seedDetail()
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server?.id).toBe(identity.id))
    apiFetchMock.mockRejectedValue(new ApiError("denied", status))
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.server).toBeNull())
    expect(registry.collections.servers.get(identity.id)).toBeUndefined()
  })

  it("keeps the null-server query disabled without issuing API requests", () => {
    const rendered = renderHook(() => useServer(null), { wrapper: Owner })
    expect(rendered.result.current.fetchStatus).toBe("idle")
    expect(rendered.result.current.server).toBeNull()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("executes the enabled hook query through the projected detail adapter", async () => {
    seedList(); apiFetchMock.mockImplementation(detailApi)
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server).toMatchObject({ ...identity, categories: [{ id: "cat_1", channels: [] }] }))
    expect(client.getQueryData(communityKeys.server(identity.id))).toBe(identity.id)
  })

  it("starts server-detail coverage before transport and preserves a later arrival", async () => {
    seedList()
    let release!: (value: { channels: [] }) => void
    apiFetchMock.mockImplementation((url: string) => url.endsWith("/channels") ? new Promise((resolve) => { release = resolve }) : Promise.resolve(detailApi(url)))
    const projection = getActiveAccountUnreadProjection(client)
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "before", serverId: identity.id, seq: 1 })
    const request = fetchDetail()
    await waitFor(() => expect(release).toBeTypeOf("function"))
    projection.recordArrival({ channelId: "after", serverId: identity.id, seq: 2 })
    release({ channels: [] }); await request
    expect(projection.projectUnread("server-detail:srv_1", "before", false)).toBe(false)
    expect(projection.projectUnread("server-detail:srv_1", "after", false)).toBe(true)
  })

  it("cancels server-detail snapshot coverage when transport fails before unread data", async () => {
    seedList(); apiFetchMock.mockRejectedValue(new Error("offline"))
    await expect(fetchDetail()).rejects.toThrow("offline")
    expect(getActiveAccountUnreadProjection(client).inspectForTests().pendingSnapshots).toBe(0)
  })

  it.each([["offline", new Error("offline")], ["5xx", new ApiError("unavailable", 503)]])("keeps the cached server list on a transient %s failure", async (_label, error) => {
    seedDetail(); apiFetchMock.mockRejectedValue(error)
    await expect(fetchDetail()).rejects.toBe(error)
    expect(client.getQueryData(communityKeys.servers())).toEqual([identity.id])
    expect(registry.collections.servers.get(identity.id)).toMatchObject({ ...identity, detailComplete: true })
  })

  it.each([403, 404])("evicts live and persisted server state on definitive %s", async (status) => {
    seedDetail([{ id: "c1", name: "General", active: false, unread: false }])
    apiFetchMock.mockRejectedValue(new ApiError("denied", status))
    await expect(fetchDetail()).rejects.toBeInstanceOf(CancelledError)
    expect(client.getQueryState(communityKeys.server(identity.id))).toBeUndefined()
    expect(client.getQueryData(communityKeys.servers())).toEqual([])
    expect(registry.collections.servers.get(identity.id)).toBeUndefined()
    expect(registry.collections.channels.get("c1")).toBeUndefined()
    expect(Array.from(registry.collections.serverMemberships.values())).toEqual([])
  })

  it("does not merge stale positives from the retired server unread endpoint", async () => {
    seedList(); apiFetchMock.mockImplementation((url: string) => url.endsWith("/unreads") ? { channelIds: ["c1"], sources: [{ channelId: "c1", lastUnreadSeq: 3 }], stale: true } : detailApi(url))
    await expect(fetchDetail()).resolves.toBe(identity.id)
    expect(getActiveAccountUnreadProjection(client).projectUnread("server-detail:srv_1", "c1", false)).toBe(false)
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).endsWith("/unreads"))).toBe(false)
  })

  it("projects child scope metadata and confirms every loaded channel", async () => {
    seedList()
    apiFetchMock.mockImplementation((url: string) => url.endsWith("/channels") ? { channels: [{ id: "forum_1", name: "Forum", type: "forum", categoryId: "cat_1" }] } : detailApi(url))
    const projection = getActiveAccountUnreadProjection(client)
    projection.setNotificationPolicy({ server: { srv_1: "all" }, channel: { forum_1: "nothing" } })
    projection.retireAccessScope({ kind: "channel", channelId: "forum_1" }); projection.grantAccessScope({ kind: "channel", channelId: "forum_1" })
    await fetchDetail()
    expect(registry.collections.channels.get("forum_1")).toMatchObject({ serverId: identity.id, type: "forum" })
    expect(projection.allowsAccess({ channelId: "forum_1", serverId: identity.id })).toBe(true)
    expect(projection.projectUnread("server-detail:srv_1", "post_1", false, 4)).toBe(false)
    projection.recordArrival({ channelId: "forum_1", serverId: identity.id, seq: 5 })
    expect(projection.projectUnread("server-detail:srv_1", "forum_1", false, 5)).toBe(false)
  })

  it("projects server-detail channels from canonical sources only", async () => {
    seedDetail([{ id: "c1", name: "One", active: false, unread: false }, { id: "c2", name: "Two", active: false, unread: true }]); attention("c1")
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server?.categories[0]?.channels.map((channel) => channel.unread)).toEqual([true, false]))
    act(() => client.setQueryData(communityKeys.server(identity.id), { id: identity.id, categories: [{ channels: [{ id: "raw", unread: true }] }] }))
    expect(rendered.result.current.server?.categories[0]?.channels.map((channel) => channel.id)).toEqual(["c1", "c2"])
  })

  it("does not retain rolling-deploy server-detail unread without canonical attention", async () => {
    seedDetail([{ id: "c1", name: "One", active: false, unread: true }, { id: "forum-base", name: "Base", type: "forum", active: false, unread: true }, { id: "forum-child", name: "Child", type: "forum", active: false, unread: true }])
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server?.categories[0]?.channels.map((channel) => channel.unread)).toEqual([false, false, false]))
    act(() => seedDetail([{ id: "c1", name: "One", active: false, unread: false }]))
    await waitFor(() => expect(rendered.result.current.server?.categories[0]?.channels.map((channel) => channel.unread)).toEqual([false]))
  })

  it("composes a single server detail from canonical resources", async () => {
    apiFetchMock.mockImplementation((url: string) => url.endsWith("/channels") ? { channels: [{ id: "ch_1", name: "general", categoryId: "cat_1" }, { id: "ch_2", name: "loose", categoryId: null }] } : detailApi(url))
    await fetchDetail()
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server).toMatchObject({ ...identity, categories: [{ id: "cat_1", channels: [{ id: "ch_1", unread: false }] }, { id: "__uncategorized__", channels: [{ id: "ch_2", unread: false }] }] }))
    expect(client.getQueryData(communityKeys.server(identity.id))).toBe(identity.id)
    expect(client.getQueryData(communityKeys.servers())).toEqual([identity.id])
  })

  it("passes the navigation AbortSignal to every server-detail resource", async () => {
    seedList()
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const result = serverProjectedQueryFn(client, identity.id, controller.signal)()
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    const signals = apiFetchMock.mock.calls.map(([, options]) => options.signal as AbortSignal)
    for (const path of ["categories", "channels"]) expect(apiFetchMock).toHaveBeenCalledWith(`/api/community/servers/${identity.id}/${path}`, expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    controller.abort(new DOMException("Retired navigation", "AbortError"))
    await rejected
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(client.getQueryData(communityKeys.server(identity.id))).toBeUndefined()
  })

  it("resolves warm canonical detail without joining an in-flight rail replacement", async () => {
    seedList()
    let release!: (value: { servers: typeof identity[] }) => void
    apiFetchMock.mockImplementation((url: string) => url === "/api/community/servers" ? new Promise((resolve) => { release = resolve }) : Promise.resolve(detailApi(url)))
    const rail = fetchList()
    await waitFor(() => expect(release).toBeTypeOf("function"))
    try {
      await expect(fetchDetail()).resolves.toBe(identity.id)
      expect(client.getQueryState(communityKeys.servers())?.fetchStatus).toBe("fetching")
      expect(registry.collections.servers.get(identity.id)).toMatchObject(identity)
    } finally { release({ servers: [identity] }); await rail }
  })

  it("joins a native in-flight rail read for a cold canonical identity without duplicate IO", async () => {
    let release!: (value: { servers: typeof identity[] }) => void
    apiFetchMock.mockImplementation((url: string) => url === "/api/community/servers" ? new Promise((resolve) => { release = resolve }) : Promise.resolve(detailApi(url)))
    const rail = fetchList()
    await waitFor(() => expect(release).toBeTypeOf("function"))
    const detail = fetchDetail()
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/channels"))).toHaveLength(1))
    expect(client.getQueryState(communityKeys.server(identity.id))?.fetchStatus).toBe("fetching")
    release({ servers: [identity] })
    await expect(rail).resolves.toEqual([identity.id]); await expect(detail).resolves.toBe(identity.id)
    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(1)
  })

  it("reads warm server identity without issuing another list request", async () => {
    seedList(); apiFetchMock.mockImplementation(detailApi)
    await expect(fetchDetail()).resolves.toBe(identity.id)
    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not cold-boot forum unread from the retired server unread endpoint", async () => {
    apiFetchMock.mockImplementation((url: string) => url.endsWith("/channels") ? { channels: [{ id: "forum_1", name: "Forum", type: "forum", categoryId: "cat_1" }] } : detailApi(url))
    const rendered = renderHook(() => useServer(identity.id), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.server?.categories[0]?.channels[0]?.unread).toBe(false))
    expect(rendered.result.current.server?.forumUnreadState).toBeUndefined()
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).endsWith("/unreads"))).toBe(false)
  })

  it("nests the server(id) key under servers() so prefix invalidation cascades", async () => {
    apiFetchMock.mockImplementation(detailApi)
    await fetchDetail()
    await client.invalidateQueries({ queryKey: communityKeys.servers() })
    expect(client.getQueryState(communityKeys.server(identity.id))?.isInvalidated).toBe(true)
    apiFetchMock.mockClear(); await fetchDetail()
    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(client.getQueryState(communityKeys.server(identity.id))?.isInvalidated).toBe(false)
  })

  it("does not issue a raw server unread read", async () => {
    apiFetchMock.mockImplementation(detailApi)
    await expect(fetchDetail()).resolves.toBe(identity.id)
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).endsWith("/unreads"))).toBe(false)
  })
})


function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("qualified viewer server role", () => {
  it("uses the live own membership before roster pagination and follows member-id-only demotion", async () => {
    apiFetchMock.mockResolvedValue({ servers: [{ ...identity, role: "admin", memberId: "own-member" }] })
    await fetchList()
    const view = renderHook(() => useViewerServerRole(identity.id, "viewer"), { wrapper: Owner })
    await waitFor(() => expect(view.result.current).toBe("admin"))
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/community/servers"])
    act(() => publishCommunityChannelDirectory(client, { directory: [{ id: identity.id, name: identity.name, discriminator: identity.discriminator, channels: [] }], proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined } }))
    expect(registry.collections.serverMemberships.get("srv_1:viewer")).toMatchObject({ role: "admin", memberId: "own-member" })
    act(() => projectCommunityWsEventToDb(client, { type: "community:member.update", serverId: identity.id, memberId: "own-member", changes: { role: "member" } }))
    await waitFor(() => expect(view.result.current).toBe("member"))
    view.unmount()
  })

  it("retains a current own role when access to an unrelated channel is revoked", async () => {
    apiFetchMock.mockResolvedValue({ servers: [{ ...identity, role: "admin", memberId: "own-member" }] })
    await fetchList()
    const view = renderHook(() => useViewerServerRole(identity.id, "viewer"), { wrapper: Owner })
    await waitFor(() => expect(view.result.current).toBe("admin"))
    act(() => registry.runtime.ws.actions.revokeChannelAccess("other-server", "other-channel"))
    expect(view.result.current).toBe("admin")
    view.unmount()
  })

  it("does not authorize a restored role, a revoked server or another viewer", async () => {
    seedList()
    registry.collections.serverMemberships.utils.writeUpsert([{ ...registry.collections.serverMemberships.get("srv_1:viewer")!, role: "admin" }])
    const held = deferred<{ servers: Array<typeof identity & { role: string; memberId: string }> }>()
    apiFetchMock.mockReturnValue(held.promise)
    const view = renderHook(({ viewerId }) => useViewerServerRole(identity.id, viewerId), { wrapper: Owner, initialProps: { viewerId: "viewer" } })
    expect(view.result.current).toBeUndefined()
    await act(async () => { const request = fetchList(); held.resolve({ servers: [{ ...identity, role: "admin", memberId: "own-member" }] }); await request })
    await waitFor(() => expect(view.result.current).toBe("admin"))
    view.rerender({ viewerId: "other-account" })
    expect(view.result.current).toBeUndefined()
    view.rerender({ viewerId: "viewer" })
    act(() => registry.runtime.ws.actions.revokeServerAccess(identity.id))
    expect(view.result.current).toBeUndefined()
    view.unmount()
  })
})
