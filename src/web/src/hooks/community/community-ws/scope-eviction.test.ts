import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { ingestServerDetail } from "@/lib/community-db/sync"
import {
  beginOwnerServerDelete,
  cancelOwnerServerDelete,
  commitOwnerServerDelete,
  createOwnerServerDeleteRouteToken,
  isOwnerServerDeleteRouteProtected,
  observeOwnerServerDeleteRouteCommit,
} from "@/lib/community/eject-server"
import {
  evictServerChannelScopes,
  flushOwnerServerDeleteAfterSuccess,
  flushOwnerServerDeleteRouteCommit,
} from "./scope-eviction"

describe("owner-delete scope eviction", () => {
  const deletedServerId = "srv_owner_deleted"
  const otherServerId = "srv_other"


  it("purges the registered canonical server during immediate scope eviction", async () => {
    const queryClient = new QueryClient()
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    ingestServerDetail(registry, {
      id: otherServerId, name: "Other", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [],
    })

    expect(evictServerChannelScopes(queryClient, otherServerId)).toBe(true)
    expect(registry.collections.servers.get(otherServerId)).toBeUndefined()

    unregister()
    await registry.cleanup()
  })

  it("merges mutation and WS eviction until one safe route commit flushes once", () => {
    const queryClient = new QueryClient()
    createCommunityDbRegistry(queryClient, "viewer")
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken(queryClient)

    beginOwnerServerDelete(queryClient, deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(commitOwnerServerDelete(queryClient, deletedServerId, token)).toBe(false)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeDefined()

    expect(observeOwnerServerDeleteRouteCommit(queryClient,
      `/c/channels/${deletedServerId}/channel-1`,
    )).toEqual([])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])

    expect(observeOwnerServerDeleteRouteCommit(queryClient, "/c/me")).toEqual([deletedServerId])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([deletedServerId])
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
    expect(removeQueries.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.server(deletedServerId)))).toHaveLength(1)
    expect(isOwnerServerDeleteRouteProtected(queryClient, deletedServerId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(queryClient, deletedServerId, token)).toBe(true)

    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.server(deletedServerId)))).toHaveLength(1)
  })

  it("keeps unrelated Servers immediate and releases a cancelled attempt", () => {
    const queryClient = new QueryClient()
    createCommunityDbRegistry(queryClient, "viewer")
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    queryClient.setQueryData(communityKeys.server(otherServerId), {
      id: otherServerId,
      categories: [],
    })
    const token = createOwnerServerDeleteRouteToken(queryClient)

    beginOwnerServerDelete(queryClient, deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, otherServerId)).toBe(true)
    expect(queryClient.getQueryState(communityKeys.server(otherServerId))).toBeUndefined()
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeDefined()

    cancelOwnerServerDelete(queryClient, deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(true)
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
  })

  it("flushes immediately when success follows an already-safe commit", () => {
    const queryClient = new QueryClient()
    createCommunityDbRegistry(queryClient, "viewer")
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken(queryClient)

    beginOwnerServerDelete(queryClient, deletedServerId, token)
    expect(observeOwnerServerDeleteRouteCommit(queryClient, "/c/me")).toEqual([])
    expect(commitOwnerServerDelete(queryClient, deletedServerId, token)).toBe(true)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(true)

    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
    expect(removeQueries.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.server(deletedServerId)))).toHaveLength(1)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.server(deletedServerId)))).toHaveLength(1)
  })

  it("uses the latest committed route fact at DELETE success", () => {
    const queryClient = new QueryClient()
    createCommunityDbRegistry(queryClient, "viewer")
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken(queryClient)

    beginOwnerServerDelete(queryClient, deletedServerId, token)
    observeOwnerServerDeleteRouteCommit(queryClient, "/c/me")
    observeOwnerServerDeleteRouteCommit(queryClient,
      `/c/channels/${deletedServerId}/channel-1`,
    )
    expect(commitOwnerServerDelete(queryClient, deletedServerId, token)).toBe(false)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(false)
    expect(removeQueries).not.toHaveBeenCalled()

    expect(observeOwnerServerDeleteRouteCommit(queryClient, "/c/me")).toEqual([deletedServerId])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([deletedServerId])
    expect(removeQueries.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.server(deletedServerId)))).toHaveLength(1)
  })
})
