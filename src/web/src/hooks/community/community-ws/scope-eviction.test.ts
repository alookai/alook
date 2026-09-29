import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"
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

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

describe("owner-delete scope eviction", () => {
  const deletedServerId = "srv_owner_deleted"
  const otherServerId = "srv_other"

  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/community/servers") return { servers: [] }
      if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
      if (path === "/api/community/users/me/dms") return { conversations: [] }
      if (path === "/api/community/users/me/server-folders") return { folders: [] }
      if (path === "/api/community/users/me/notifications") return []
      if (path === "/api/community/users/me/attention") {
        return {
          scopes: [], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        }
      }
      throw new Error(`unexpected registry preload: ${path}`)
    })
    cancelOwnerServerDelete(deletedServerId)
    cancelOwnerServerDelete(otherServerId)
  })

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
    queryClient.setQueryData(serverDetailResourceKey("anon", deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(commitOwnerServerDelete(deletedServerId, token)).toBe(false)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(queryClient.getQueryState(serverDetailResourceKey("anon", deletedServerId))).toBeDefined()

    expect(observeOwnerServerDeleteRouteCommit(
      `/c/channels/${deletedServerId}/channel-1`,
    )).toEqual([])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])

    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([deletedServerId])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([deletedServerId])
    expect(queryClient.getQueryState(serverDetailResourceKey("anon", deletedServerId))).toBeUndefined()
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(isOwnerServerDeleteRouteProtected(deletedServerId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(deletedServerId, token)).toBe(true)

    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(1)
  })

  it("keeps unrelated Servers immediate and releases a cancelled attempt", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(serverDetailResourceKey("anon", deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    queryClient.setQueryData(serverDetailResourceKey("anon", otherServerId), {
      id: otherServerId,
      categories: [],
    })
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, otherServerId)).toBe(true)
    expect(queryClient.getQueryState(serverDetailResourceKey("anon", otherServerId))).toBeUndefined()
    expect(queryClient.getQueryState(serverDetailResourceKey("anon", deletedServerId))).toBeDefined()

    cancelOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(true)
    expect(queryClient.getQueryState(serverDetailResourceKey("anon", deletedServerId))).toBeUndefined()
  })

  it("flushes immediately when success follows an already-safe commit", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(serverDetailResourceKey("anon", deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([])
    expect(commitOwnerServerDelete(deletedServerId, token)).toBe(true)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(true)

    expect(queryClient.getQueryState(serverDetailResourceKey("anon", deletedServerId))).toBeUndefined()
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(1)
  })

  it("uses the latest committed route fact at DELETE success", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(serverDetailResourceKey("anon", deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    observeOwnerServerDeleteRouteCommit("/c/me")
    observeOwnerServerDeleteRouteCommit(
      `/c/channels/${deletedServerId}/channel-1`,
    )
    expect(commitOwnerServerDelete(deletedServerId, token)).toBe(false)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(false)
    expect(removeQueries).not.toHaveBeenCalled()

    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([deletedServerId])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([deletedServerId])
    expect(removeQueries).toHaveBeenCalledTimes(1)
  })
})
