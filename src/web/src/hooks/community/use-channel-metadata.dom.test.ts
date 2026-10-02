import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
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
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})
afterEach(async () => {
  unregisters.splice(0).forEach((unregister) => unregister())
  for (const registry of registries.splice(0)) { await registry["cleanup"](); registry.queryClient.clear() }
})

describe("shared Channel resource and canonical DM publication", () => {
  it("publishes a real nullable DM response without losing peer closure or granting a server scope", async () => {
    const { client, registry, wrapper } = await fixture()
    ingestDms(registry, dms)
    apiFetch.mockResolvedValue(metadata)
    await client.fetchQuery(channelMetadataOptions(client, null, metadata.id))
    const route = renderHook(() => ({ route: useDmRouteVerification(metadata.id), peers: useDmProjection() }), { wrapper })
    await waitFor(() => expect(route.result.current.route.status).toBe("present"))
    await waitFor(() => expect(route.result.current.peers?.[0]).toMatchObject({ id: metadata.id, name: "Peer", preview: "canonical preview" }))
    expect(registry.collections.channels.get(metadata.id)).toMatchObject({ name: "", serverId: null, type: "dm" })
    expect(useCommunityWsStore.getState().channelAccessScopes.size).toBe(0)
    expect(useCommunityWsStore.getState().revokedServerIds.size).toBe(0)
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
    expect(apiFetch).toHaveBeenCalledWith(`/api/community/channels/${metadata.id}/read-state`, { signal: expect.any(AbortSignal) })
    expect(client.getQueryData(metadataKey)).toMatchObject({ type: "dm" })
    route.unmount()
  })

  it("removes a prior history receipt after an explicit read denial without retrying it", async () => {
    const { client, registry, wrapper } = await fixture()
    publishDms(registry)
    client.setQueryData(metadataKey, (previous: object | undefined) => ({ ...previous, historyVerification: captureChannelMetadataToken(metadata.id) }))
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
      act(() => { useCommunityWsStore.getState().activateProfileAccount("other"); useCommunityWsStore.getState().activateProfileAccount("viewer") })
    } else {
      client.removeQueries({ queryKey: metadataKey, exact: true })
      publishDms(registry)
    }
    await act(async () => request.resolve(readState))
    if (race === "account") await waitFor(() => expect(route.result.current.error?.name).toBe("AbortError"))
    else await waitFor(() => expect(route.result.current.snapshot).toEqual(readState))
    expect(client.getQueryData(metadataKey)).not.toHaveProperty("historyVerification")
    route.unmount()
  })
})
