import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { getLastChannel, setLastChannel } from "@/lib/community/last-channel"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useDmProjection } from "@/lib/community-db/projections"
import { applyCommunityDmBlockAccess, assertCommunityLiveSnapshotTokenCurrent, publishCommunityMessages, captureCommunityLiveSnapshotToken, ingestDms, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { useChannelMetadata } from "./use-channel-metadata"
import { useDmReadStateSnapshot } from "./use-dm-read-state"
import { startConversationNavigationWarmup } from "@/lib/community/conversation-navigation-warmup"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
const metadata = { id: "dm-a", serverId: null, type: "dm", name: null,
  parentChannelId: null, parentMessageId: null, creatorId: null, archived: false,
  lastMessageAt: null, createdAt: "2026-10-02T00:00:00Z" }
const dms = { conversations: [{ id: metadata.id, userId: "peer", name: "Peer", discriminator: "0001",
  avatar: "P", status: "offline" as const, preview: "canonical preview" }] }
const readState = { lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
const metadataKey = communityKeys.channelMeta(null, metadata.id)
const registries: CommunityDbRegistry[] = []
const unregisters: Array<() => void> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function fixture(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  const registry = createCommunityDbRegistry(client, "viewer")
  registries.push(registry)
  await registry.preload()
  unregisters.push(registerCommunityDbRegistry(registry))
  const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(QueryClientProvider, { client },
    React.createElement(CommunityDbProvider, { registry }, children))
  return { client, registry, wrapper }
}
function publishDms(registry: CommunityDbRegistry) {
  publishCommunityLiveSnapshot(registry.queryClient, { snapshot: { kind: "dms", data: dms },
    proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(registry.queryClient), signal: undefined } })
}
async function qualifyMetadata(client: QueryClient, value = metadata) {
  apiFetch.mockResolvedValue(value)
  await client.query({ ...channelMetadataOptions(client, value.serverId, value.id), staleTime: 0 })
  apiFetch.mockReset()
}
beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(async () => {
  await act(async () => {
    unregisters.splice(0).forEach((unregister) => unregister())
    for (const registry of registries.splice(0)) { await registry["cleanup"](); registry.queryClient.clear() }
  })
})

describe("shared Channel resource and canonical DM publication", () => {
  it("retires a verified DM on block and waits for fresh metadata after unblock", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    await qualifyMetadata(client)
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.isVerified).toBe(true)
    const original = route.result.current.data!.identityProof!
    act(() => applyCommunityDmBlockAccess(registry, "peer", true))
    expect(route.result.current.isVerified).toBe(false)
    expect(isChannelMetadataTokenCurrent(original)).toBe(false)
    expect(registry.collections.channels.has(metadata.id)).toBe(true)
    const detail = deferred<typeof metadata>()
    apiFetch.mockReturnValue(detail.promise)
    act(() => applyCommunityDmBlockAccess(registry, "peer", false))
    expect(route.result.current.isVerified).toBe(false)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => detail.resolve(metadata))
    await waitFor(() => expect(route.result.current.isVerified).toBe(true))
    expect(isChannelMetadataTokenCurrent(route.result.current.data!.identityProof!)).toBe(true)
    route.unmount()
  })
  it("retires only the blocked DM while a sibling stays readable and rejects old target and bulk writes", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, { conversations: [...dms.conversations, { ...dms.conversations[0], id: "dm-b", userId: "other-peer" }] })
    await qualifyMetadata(client)
    await qualifyMetadata(client, { ...metadata, id: "dm-b" })
    const target = captureChannelMetadataToken(client, metadata.id)
    const sibling = captureChannelMetadataToken(client, "dm-b")
    const bulk = captureCommunityLiveSnapshotToken(client)
    const beforeEpoch = registry.runtime.ws.get().accessEpoch
    const route = renderHook(() => ({ first: useChannelMetadata(null, metadata.id), second: useChannelMetadata(null, "dm-b") }), { wrapper })
    await waitFor(() => expect(route.result.current.second.canRead).toBe(true))
    act(() => applyCommunityDmBlockAccess(registry, "peer", true))
    expect(route.result.current.first).toMatchObject({ identityKnown: true, canRead: false, status: "denied" })
    expect(route.result.current.second).toMatchObject({ identityKnown: true, canRead: true, status: "readable" })
    expect(registry.runtime.ws.get().accessEpoch).toBe(beforeEpoch)
    expect(isChannelMetadataTokenCurrent(sibling)).toBe(true)
    expect(() => publishCommunityMessages(client, { channelId: metadata.id, messages: [], proof: { token: target } })).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(() => assertCommunityLiveSnapshotTokenCurrent(client, bulk, undefined)).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(apiFetch).not.toHaveBeenCalled()
    route.unmount()
  })

  it("leaves an absent target disabled without starting a metadata request", async () => {
    const { client, wrapper } = await fixture()
    const route = renderHook(() => useChannelMetadata(null, undefined), { wrapper })
    expect(route.result.current.isVerified).toBe(false)
    expect(route.result.current.fetchStatus).toBe("idle")
    expect(client.getQueryState(communityKeys.channelMeta(null, "__none__"))?.fetchStatus).toBe("idle")
    expect(apiFetch).not.toHaveBeenCalled()
    route.unmount()
  })

  it("invalidates expired qualification and waits for a current metadata receipt", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    await qualifyMetadata(client)
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.isVerified).toBe(true)
    expect(apiFetch).not.toHaveBeenCalled()
    act(() => registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 })))
    expect(route.result.current.isVerified).toBe(false)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => request.resolve(metadata))
    await waitFor(() => expect(route.result.current.isVerified).toBe(true))
    expect(isChannelMetadataTokenCurrent(route.result.current.data!.identityProof!)).toBe(true)
    route.unmount()
  })

  it("publishes a real nullable DM response without losing peer closure or granting a server scope", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    apiFetch.mockResolvedValue(metadata)
    await client.query(channelMetadataOptions(client, null, metadata.id))
    const route = renderHook(() => ({ route: useChannelMetadata(null, metadata.id), peers: useDmProjection() }), { wrapper })
    await waitFor(() => expect(route.result.current.route.status).toBe("readable"))
    await waitFor(() => expect(route.result.current.peers?.[0]).toMatchObject({ id: metadata.id, name: "Peer", preview: "canonical preview" }))
    expect(registry.collections.channels.get(metadata.id)).toMatchObject({ name: "", serverId: null, type: "dm" })
    expect(registry.runtime.ws.get().channelAccessScopes.get(metadata.id)).toMatchObject({ serverId: null, generation: 0, revoked: false })
    expect(registry.runtime.ws.get().revokedServerIds.size).toBe(0)
    expect(apiFetch).toHaveBeenCalledOnce()
    route.unmount()
  })

  it("uses a list receipt for identity and starts the protected GET for reading", async () => {
    const { registry, wrapper } = await fixture()
    publishDms(registry)
    const detail = deferred<typeof metadata>()
    apiFetch.mockReturnValue(detail.promise)
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.identityKnown).toBe(true)
    expect(route.result.current.canRead).toBe(false)
    expect(route.result.current.data?.readProof).toBeUndefined()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => detail.resolve(metadata))
    await waitFor(() => expect(route.result.current.canRead).toBe(true))
    route.unmount()
  })

  it("keeps restored DM structure pending until current target metadata qualifies it", async () => {
    const donor = await fixture()
    ingestDms(donor.registry, dms)
    const restored = new QueryClient()
    for (const name of ["channels", "channelMemberships", "profiles"] as const) {
      const key = communityKeys.communityDbCollection("viewer", name)
      restored.setQueryData(key, donor.client.getQueryData(key))
    }
    const { wrapper } = await fixture(restored)
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.status).toBe("pending")
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => request.resolve(metadata))
    await waitFor(() => expect(route.result.current.status).toBe("readable"))
    route.unmount()
  })
})

describe("DM history permission stays separate from metadata identity", () => {
  it("qualifies V2 reading from metadata while the position snapshot remains pending", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    const pending = deferred<typeof readState>()
    apiFetch.mockImplementation((path: string) => path.endsWith("/read-state") ? pending.promise
      : { ...metadata, readContractVersion: 2, accessDecision: { channelId: metadata.id, canRead: true, canSend: true, canCreateDiscussion: false } })
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(route.result.current.metadata.data?.readProof).toBeDefined())
    expect(route.result.current.metadata.isVerified).toBe(true)
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.readProof!)).toBe(true)
    expect(route.result.current.read).toMatchObject({ snapshot: null, isFetching: true })
    expect(client.getQueryData(metadataKey)).toHaveProperty("readProof")
    await act(async () => pending.resolve(readState))
    await waitFor(() => expect(route.result.current.read.snapshot).toEqual(readState))
    route.unmount()
  })

  it("keeps an early protected read receipt on the same resource while metadata is pending", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    const detail = deferred<typeof metadata>()
    apiFetch.mockImplementation((path: string) => path.endsWith("/messages")
      ? Promise.resolve({ messages: [], hasMore: false, surfaceReceipt: { channelId: metadata.id, surfaceKind: "dm" } })
      : path.endsWith("/read-state") ? Promise.resolve(readState) : detail.promise)
    act(() => { startConversationNavigationWarmup(client, {
      href: `/c/me/${metadata.id}`, viewerId: "viewer", channelId: metadata.id, scopeKind: "dm",
    }, registry.runtime.ws.get().accessEpoch) })
    await waitFor(() => expect(client.getQueryData<{ readProof?: unknown }>(metadataKey)?.readProof).toBeDefined())
    expect(client.getQueryData<{ identityProof?: unknown }>(metadataKey)?.identityProof).toBeUndefined()
    expect(client.getQueryState(metadataKey)?.isInvalidated).toBe(true)
    const originalResource = client.getQueryCache().find({ queryKey: metadataKey, exact: true })
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.canRead).toBe(true)
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path === `/api/community/channels/${metadata.id}`)).toHaveLength(1))
    await act(async () => detail.resolve(metadata))
    await waitFor(() => expect(route.result.current.isVerified).toBe(true))
    expect(isChannelMetadataTokenCurrent(route.result.current.data!.readProof!)).toBe(true)
    expect(client.getQueryCache().find({ queryKey: metadataKey, exact: true })).toBe(originalResource)
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
    route.unmount()
  })

  it.each(["absent", "pending"] as const)("retains a read-first Inbox receipt on the original %s Channel resource until metadata settles", async (order) => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    if (order === "pending") client.getQueryCache().build(client, client.defaultQueryOptions(channelMetadataOptions(client, null, metadata.id)))
    expect(client.getQueryData(metadataKey)).toBeUndefined()
    expect(!!client.getQueryCache().find({ queryKey: metadataKey, exact: true })).toBe(order === "pending")
    const read = deferred<typeof readState>()
    const detail = deferred<typeof metadata>()
    apiFetch.mockImplementation((path: string) => path.endsWith("/messages")
      ? Promise.resolve({ messages: [], hasMore: false, surfaceReceipt: { channelId: metadata.id, surfaceKind: "dm" } })
      : path.endsWith("/read-state") ? read.promise : detail.promise)
    act(() => { startConversationNavigationWarmup(client, {
      href: `/c/me/${metadata.id}`, viewerId: "viewer", channelId: metadata.id, scopeKind: "dm",
    }, registry.runtime.ws.get().accessEpoch) })
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path === `/api/community/channels/${metadata.id}`)).toHaveLength(1))
    const originalResource = client.getQueryCache().find({ queryKey: metadataKey, exact: true })
    await act(async () => read.resolve(readState))
    await waitFor(() => expect(route.result.current.read.snapshot).toEqual(readState))
    expect(route.result.current.metadata.canRead).toBe(true)
    expect(client.getQueryData<{ readProof?: unknown }>(metadataKey)?.readProof).toBeDefined()
    await act(async () => detail.resolve(metadata))
    await waitFor(() => expect(route.result.current.metadata.isVerified).toBe(true))
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.readProof!)).toBe(true)
    expect(client.getQueryCache().find({ queryKey: metadataKey, exact: true })).toBe(originalResource)
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
    expect(apiFetch.mock.calls.filter(([path]) => path === `/api/community/channels/${metadata.id}`)).toHaveLength(1)
    route.unmount()
  })

  it("qualifies the same pending Inbox DM read joined by the mounted route", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    const request = deferred<typeof readState>()
    apiFetch.mockImplementation((path: string) => path.endsWith("/messages")
      ? Promise.resolve({ messages: [], hasMore: false, surfaceReceipt: { channelId: metadata.id, surfaceKind: "dm" } })
      : path.endsWith("/read-state") ? request.promise : new Promise(() => {}))
    act(() => { startConversationNavigationWarmup(client, {
      href: `/c/me/${metadata.id}`, viewerId: "viewer", channelId: metadata.id, scopeKind: "dm",
    }, registry.runtime.ws.get().accessEpoch) })
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    expect(route.result.current.metadata.canRead).toBe(false)
    expect(route.result.current.metadata.data?.readProof).toBeUndefined()
    await act(async () => request.resolve(readState))
    await waitFor(() => expect(route.result.current.read.snapshot).toEqual(readState))
    expect(route.result.current.metadata.data?.readProof).toBeDefined()
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.readProof!)).toBe(true)
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
    route.unmount()
  })

  it.each((["published", "absent", "pending"] as const).flatMap((order) =>
    (["denial403", "denial404", "account", "access", "replacement"] as const).map((race) => ({ order, race })),
  ))("cannot grant $order Channel history from the shared Inbox read after $race", async ({ order, race }) => {
    const { client, registry, wrapper } = await fixture()
    if (order === "published") publishDms(registry)
    else {
      ingestDms(registry, dms)
      if (order === "pending") client.getQueryCache().build(client, client.defaultQueryOptions(channelMetadataOptions(client, null, metadata.id)))
    }
    const request = deferred<typeof readState>()
    if (order === "published" && race.startsWith("denial")) {
      client.setQueryData(metadataKey, (previous: object | undefined) => ({ ...previous, readProof: captureChannelMetadataToken(client, metadata.id) }))
    }
    apiFetch.mockImplementation((path: string) => path.endsWith("/messages")
      ? Promise.resolve({ messages: [], hasMore: false, surfaceReceipt: { channelId: metadata.id, surfaceKind: "dm" } })
      : request.promise)
    act(() => { startConversationNavigationWarmup(client, {
      href: `/c/me/${metadata.id}`, viewerId: "viewer", channelId: metadata.id, scopeKind: "dm",
    }, registry.runtime.ws.get().accessEpoch) })
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1))
    const route = renderHook(() => useDmReadStateSnapshot(metadata.id), { wrapper })
    act(() => {
      if (race === "account") {
        registry.runtime.ws.actions.activateProfileAccount("other")
        registry.runtime.ws.actions.activateProfileAccount("viewer")
      } else if (race === "access") {
        registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 }))
      } else if (race === "replacement") {
        client.removeQueries({ queryKey: metadataKey, exact: true })
        publishDms(registry)
      }
    })
    await act(async () => {
      if (race.startsWith("denial")) request.reject(Object.assign(new Error("denied"), { status: Number(race.slice(6)) }))
      else request.resolve(readState)
    })
    if (race === "replacement") await waitFor(() => expect(route.result.current.snapshot).toEqual(readState))
    else await waitFor(() => expect(route.result.current.error).toMatchObject(race.startsWith("denial")
      ? { status: Number(race.slice(6)) } : { name: "AbortError" }))
    expect(client.getQueryData<{ readProof?: unknown }>(metadataKey)?.readProof).toBeUndefined()
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
    route.unmount()
  })

  it("keeps a transient position error local and retries that request without losing reading", async () => {
    const { client, registry, wrapper } = await fixture(new QueryClient({
      defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
    }))
    publishDms(registry)
    await qualifyMetadata(client)
    apiFetch.mockRejectedValue(new Error("offline"))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(route.result.current.read.error?.message).toBe("offline"))
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(2)
    expect(route.result.current.metadata.canRead).toBe(true)
    apiFetch.mockResolvedValue(readState)
    act(() => route.result.current.read.retry())
    await waitFor(() => expect(route.result.current.read.snapshot).toEqual(readState))
    expect(route.result.current.read.error).toBeNull()
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.readProof!)).toBe(true)
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(3)
    route.unmount()
  })

  it("records only a current read permission receipt on the existing Channel resource", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    const request = deferred<typeof readState>()
    apiFetch.mockImplementation((path: string) => path.endsWith("/read-state") ? request.promise : new Promise(() => {}))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    expect(route.result.current.metadata.identityKnown).toBe(true)
    expect(route.result.current.metadata.canRead).toBe(false)
    expect(route.result.current.metadata.data?.readProof).toBeUndefined()
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1))
    await act(async () => request.resolve(readState))
    await waitFor(() => expect(route.result.current.metadata.data?.readProof).toBeDefined())
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.readProof!)).toBe(true)
    expect(apiFetch).toHaveBeenCalledWith(`/api/community/channels/${metadata.id}/read-state`, expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(client.getQueryData(metadataKey)).toMatchObject({ id: metadata.id })
    expect(client.getQueryData(metadataKey)).not.toHaveProperty("type")
    route.unmount()
  })

  it("removes a prior history receipt after an explicit read denial without retrying it", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    client.setQueryData(metadataKey, (previous: object | undefined) => ({ ...previous, readProof: captureChannelMetadataToken(client, metadata.id) }))
    apiFetch.mockRejectedValue(Object.assign(new Error("blocked"), { status: 403 }))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(route.result.current.read.error).toMatchObject({ status: 403 }))
    expect(route.result.current.metadata.identityKnown).toBe(true)
    expect(route.result.current.metadata.status).toBe("denied")
    expect(route.result.current.metadata.data?.readProof).toBeUndefined()
    expect(apiFetch).toHaveBeenCalledOnce()
    route.unmount()
  })

  it.each(["account", "replacement"] as const)("cannot grant history from an old read completion after %s", async (race) => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    const request = deferred<typeof readState>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => useDmReadStateSnapshot(metadata.id), { wrapper })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    if (race === "account") {
      act(() => { registry.runtime.ws.actions.activateProfileAccount("other"); registry.runtime.ws.actions.activateProfileAccount("viewer") })
    } else {
      client.removeQueries({ queryKey: metadataKey, exact: true })
      publishDms(registry)
    }
    await act(async () => request.resolve(readState))
    if (race === "account") await waitFor(() => expect(route.result.current.error?.name).toBe("AbortError"))
    else await waitFor(() => expect(route.result.current.snapshot).toEqual(readState))
    expect(client.getQueryData<{ readProof?: unknown }>(metadataKey)?.readProof).toBeUndefined()
    route.unmount()
  })
})


describe("restored forum archive ambiguity", () => {
  it("waits for current metadata instead of treating a persisted opener tag as channel denial", async () => {
    const client = new QueryClient()
    const post = { ...metadata, id: "post-1", serverId: "server-1", type: "thread", name: "Post", parentChannelId: "forum-1", parentMessageId: "opener-1" }
    client.setQueryData(communityKeys.communityDbCollection("viewer", "channels"), [{ ...post, archived: true, tags: ["archived"], position: 0, muted: false, unread: false, pending: false }])
    const { registry, wrapper } = await fixture(client)
    const held = deferred<typeof post>()
    apiFetch.mockReturnValue(held.promise)
    const route = renderHook(() => useChannelMetadata("server-1", post.id), { wrapper })
    expect(route.result.current.data?.archived).toBe(true)
    expect(route.result.current.isArchived).toBe(false)
    expect(route.result.current.isVerified).toBe(false)
    await act(async () => held.resolve(post))
    await waitFor(() => expect(route.result.current.isVerified).toBe(true))
    expect(registry.collections.channels.get(post.id)).toMatchObject({ archived: false, tags: ["archived"] })
    route.unmount()
  })
})

it("retires a protected archived channel and clears its exact flat navigation memory", async () => {
  const { client, registry, wrapper } = await fixture()
  const post = { ...metadata, id: "post-archived", serverId: "server-1", type: "thread", name: "Post", parentChannelId: "forum-1", parentMessageId: "opener-archived", archived: true }
  setLastChannel("server-1", post.id)
  apiFetch.mockResolvedValue(post)
  const route = renderHook(() => useChannelMetadata("server-1", post.id), { wrapper })
  await waitFor(() => expect(route.result.current.denied).toBe(true))
  expect(getLastChannel("server-1")).toBeNull()
  expect(registry.collections.channels.get(post.id)).toBeUndefined()
  expect(registry.runtime.ws.actions.isChannelAccessRevoked(post.id, "server-1")).toBe(true)
  expect(client.getQueryData(communityKeys.channelMeta("server-1", post.id))).toMatchObject({ id: post.id })
  route.unmount()
})
