import "fake-indexeddb/auto"
import React, { useMemo } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { cancelOwnerServerDelete, claimOwnerServerDeleteNavigation, claimOwnerServerDeleteScopeFlush, completeOwnerServerDeleteScopeFlush, createOwnerServerDeleteRouteToken, isOwnerServerDeleteMeRootLanding, isOwnerServerDeleteRouteProtected, observeOwnerServerDeleteRouteCommit } from "@/lib/community/eject-server"
import { useDeleteServer } from "./servers"
const mocks = vi.hoisted(() => ({ api: vi.fn(), flushOwnerServerDeleteAfterSuccess: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/community-ws/scope-eviction", async (original) => ({ ...await original<typeof import("@/hooks/community/community-ws/scope-eviction")>(), flushOwnerServerDeleteAfterSuccess: mocks.flushOwnerServerDeleteAfterSuccess }))
type Callbacks = Parameters<typeof useDeleteServer>[0]
async function setup(serverId: string, callbacks: Omit<Callbacks, "routeToken">) {
  let client!: QueryClient, current!: ReturnType<typeof useDeleteServer>, originalToken!: Callbacks["routeToken"]
  function Probe({ activeCallbacks }: { activeCallbacks: Omit<Callbacks, "routeToken"> & Partial<Pick<Callbacks, "routeToken">> }) {
    client = useQueryClient()
    const token = useMemo(() => createOwnerServerDeleteRouteToken(client), [])
    originalToken = token
    current = useDeleteServer({ routeToken: token, ...activeCallbacks })
    return null
  }
  function Root({ visible = true, activeCallbacks = callbacks }: { visible?: boolean; activeCallbacks?: Omit<Callbacks, "routeToken"> & Partial<Pick<Callbacks, "routeToken">> }) { return <QueryProvider userId="viewer">{visible && <Probe activeCallbacks={activeCallbacks} />}</QueryProvider> }
  const mounted = render(<Root />)
  await act(async () => {
    const registry = getCommunityDbRegistry(client)!
    await registry.ready; await registry.preload()
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "servers", data: { servers: [{ id: serverId, name: "Server", initial: "S", active: false, unread: false, mentions: 0, isOwner: true, ownerId: "viewer" }] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
    client.setQueryData(communityKeys.servers(), [serverId])
  })
  return { client, routeToken: originalToken, result: { get current() { return current } }, unmount: () => mounted.rerender(<Root visible={false} />), rerender: ({ activeCallbacks }: { activeCallbacks: Callbacks }) => mounted.rerender(<Root activeCallbacks={activeCallbacks} />) }
}
beforeEach(async () => { await clearAllPersistedCaches(); mocks.api.mockReset(); mocks.flushOwnerServerDeleteAfterSuccess.mockReset() })
describe("useDeleteServer — unmounted caller with original account provider retained", () => {
  it("keeps the successful navigation handoff after the calling component unmounts", async () => {
    const serverId = "srv_unmounted_success"
    let resolve!: (value: undefined) => void
    mocks.api.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const onSuccess = vi.fn(), view = await setup(serverId, { onSuccess })
    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledOnce()
      expect([...getCommunityDbRegistry(view.client)!.collections.serverMemberships.values()].filter((row) => row.viewer)).toEqual([])
      expect(isOwnerServerDeleteRouteProtected(view.client, serverId)).toBe(true)
    })
    act(() => view.unmount())
    expect(getCommunityDbRegistry(view.client)!.runtime.lifecycle.get().active).toBe(true)
    await act(async () => resolve(undefined))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(onSuccess).toHaveBeenCalledWith({ serverId }, { needsNavigation: true })
    expect(isOwnerServerDeleteRouteProtected(view.client, serverId)).toBe(true)
    expect(claimOwnerServerDeleteNavigation(view.client, serverId, view.routeToken, "/c/me")).toBe(true)
    expect(isOwnerServerDeleteMeRootLanding(view.client)).toBe(true)
    observeOwnerServerDeleteRouteCommit(view.client, "/c/me")
    expect(isOwnerServerDeleteMeRootLanding(view.client)).toBe(true)
    expect(claimOwnerServerDeleteScopeFlush(view.client, serverId)).toBe(true)
    expect(completeOwnerServerDeleteScopeFlush(view.client, serverId)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(view.client, serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(view.client, serverId, view.routeToken)).toBe(true)
  })
  it("rolls back and clears coordination before reporting an unmounted failure", async () => {
    const serverId = "srv_unmounted_failure", failure = new Error("delete failed")
    let reject!: (error: Error) => void
    const onError = vi.fn(() => {
      expect([...getCommunityDbRegistry(client)!.collections.serverMemberships.values()].filter((row) => row.viewer).map((row) => row.serverId)).toEqual([serverId])
      expect(isOwnerServerDeleteRouteProtected(client, serverId)).toBe(false)
    })
    mocks.api.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    const view = await setup(serverId, { onError }), client = view.client
    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => { expect(mocks.api).toHaveBeenCalledOnce(); expect(isOwnerServerDeleteRouteProtected(client, serverId)).toBe(true) })
    act(() => view.unmount())
    await act(async () => reject(failure))
    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(failure, { serverId })
    observeOwnerServerDeleteRouteCommit(client, "/c/me")
    expect(claimOwnerServerDeleteScopeFlush(client, serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(client, serverId, view.routeToken)).toBe(false)
  })
  it("finishes with the originating token and callback after the route layout rerenders", async () => {
    const serverId = "srv_rerendered_success"
    let resolve!: (value: undefined) => void
    mocks.api.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const originSuccess = vi.fn(), survivorSuccess = vi.fn(), view = await setup(serverId, { onSuccess: originSuccess })
    const survivorToken = createOwnerServerDeleteRouteToken(view.client)
    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => expect(isOwnerServerDeleteRouteProtected(view.client, serverId)).toBe(true))
    observeOwnerServerDeleteRouteCommit(view.client, "/c/channels/survivor/channel-1")
    act(() => view.rerender({ activeCallbacks: { routeToken: survivorToken, onSuccess: survivorSuccess } }))
    await act(async () => resolve(undefined))
    await waitFor(() => expect(originSuccess).toHaveBeenCalledOnce())
    expect(originSuccess).toHaveBeenCalledWith({ serverId }, { needsNavigation: false })
    expect(survivorSuccess).not.toHaveBeenCalled()
    expect(mocks.flushOwnerServerDeleteAfterSuccess).toHaveBeenCalledWith(view.client, serverId)
    cancelOwnerServerDelete(view.client, serverId, view.routeToken)
  })
})
