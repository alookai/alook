import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useDmProjection } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, ingestDms, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { useChannelMetadata } from "./use-channel-metadata"
import { useDmRouteVerification } from "./use-dm-route-verification"
import { useDmReadStateSnapshot } from "./use-dm-read-state"

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
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
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
    const { registry, wrapper } = await fixture()
    publishDms(registry)
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
    expect(isChannelMetadataTokenCurrent(route.result.current.data!.verification!)).toBe(true)
    route.unmount()
  })

  it("publishes a real nullable DM response without losing peer closure or granting a server scope", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    apiFetch.mockResolvedValue(metadata)
    await client.fetchQuery(channelMetadataOptions(client, null, metadata.id))
    const route = renderHook(() => ({ route: useDmRouteVerification(metadata.id), peers: useDmProjection() }), { wrapper })
    await waitFor(() => expect(route.result.current.route.status).toBe("present"))
    await waitFor(() => expect(route.result.current.peers?.[0]).toMatchObject({ id: metadata.id, name: "Peer", preview: "canonical preview" }))
    expect(registry.collections.channels.get(metadata.id)).toMatchObject({ name: "", serverId: null, type: "dm" })
    expect(registry.runtime.ws.get().channelAccessScopes.size).toBe(0)
    expect(registry.runtime.ws.get().revokedServerIds.size).toBe(0)
    expect(apiFetch).toHaveBeenCalledOnce()
    route.unmount()
  })

  it("reuses current live canonical qualification through the same Channel Query without another GET", async () => {
    const { registry, wrapper } = await fixture()
    publishDms(registry)
    const route = renderHook(() => useChannelMetadata(null, metadata.id), { wrapper })
    expect(route.result.current.isVerified).toBe(true)
    expect(route.result.current.data?.historyVerification).toBeUndefined()
    expect(apiFetch).not.toHaveBeenCalled()
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
    const route = renderHook(() => useDmRouteVerification(metadata.id), { wrapper })
    expect(route.result.current.status).toBe("pending")
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => request.resolve(metadata))
    await waitFor(() => expect(route.result.current.status).toBe("present"))
    route.unmount()
  })
})

describe("DM history permission stays separate from metadata identity", () => {
  it("keeps a transient read error local and grants history after explicit Retry succeeds", async () => {
    const { registry, wrapper } = await fixture(new QueryClient({
      defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
    }))
    publishDms(registry)
    apiFetch.mockRejectedValue(new Error("offline"))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(route.result.current.read.error?.message).toBe("offline"))
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(route.result.current.metadata.isVerified).toBe(true)
    expect(route.result.current.metadata.data?.historyVerification).toBeUndefined()
    apiFetch.mockResolvedValue(readState)
    act(() => route.result.current.read.retry())
    await waitFor(() => expect(route.result.current.read.snapshot).toEqual(readState))
    expect(route.result.current.read.error).toBeNull()
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.historyVerification!)).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(3)
    route.unmount()
  })

  it("records only a current read permission receipt on the existing Channel resource", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    const request = deferred<typeof readState>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    expect(route.result.current.metadata.isVerified).toBe(true)
    expect(route.result.current.metadata.data?.historyVerification).toBeUndefined()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => request.resolve(readState))
    await waitFor(() => expect(route.result.current.metadata.data?.historyVerification).toBeDefined())
    expect(isChannelMetadataTokenCurrent(route.result.current.metadata.data!.historyVerification!)).toBe(true)
    expect(apiFetch).toHaveBeenCalledWith(`/api/community/channels/${metadata.id}/read-state`, expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(client.getQueryData(metadataKey)).toMatchObject({ id: metadata.id })
    expect(client.getQueryData(metadataKey)).not.toHaveProperty("type")
    route.unmount()
  })

  it("removes a prior history receipt after an explicit read denial without retrying it", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    client.setQueryData(metadataKey, (previous: object | undefined) => ({ ...previous, historyVerification: captureChannelMetadataToken(client, metadata.id) }))
    apiFetch.mockRejectedValue(Object.assign(new Error("blocked"), { status: 403 }))
    const route = renderHook(() => ({ metadata: useChannelMetadata(null, metadata.id), read: useDmReadStateSnapshot(metadata.id) }), { wrapper })
    await waitFor(() => expect(route.result.current.read.error).toMatchObject({ status: 403 }))
    expect(route.result.current.metadata.isVerified).toBe(true)
    expect(route.result.current.metadata.data?.historyVerification).toBeUndefined()
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
    expect(client.getQueryData<{ historyVerification?: unknown }>(metadataKey)?.historyVerification).toBeUndefined()
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
