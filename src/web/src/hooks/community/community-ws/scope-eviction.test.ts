import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
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

  beforeEach(() => {
    cancelOwnerServerDelete(deletedServerId)
    cancelOwnerServerDelete(otherServerId)
  })

  it("merges mutation and WS eviction until one safe route commit flushes once", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(commitOwnerServerDelete(deletedServerId, token)).toBe(false)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeDefined()

    expect(observeOwnerServerDeleteRouteCommit(
      `/c/channels/${deletedServerId}/channel-1`,
    )).toEqual([])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])

    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([deletedServerId])
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([deletedServerId])
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(isOwnerServerDeleteRouteProtected(deletedServerId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(deletedServerId, token)).toBe(true)

    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(1)
  })

  it("keeps unrelated Servers immediate and releases a cancelled attempt", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    queryClient.setQueryData(communityKeys.server(otherServerId), {
      id: otherServerId,
      categories: [],
    })
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, otherServerId)).toBe(true)
    expect(queryClient.getQueryState(communityKeys.server(otherServerId))).toBeUndefined()
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeDefined()

    cancelOwnerServerDelete(deletedServerId, token)
    expect(evictServerChannelScopes(queryClient, deletedServerId)).toBe(true)
    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
  })

  it("flushes immediately when success follows an already-safe commit", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
      id: deletedServerId,
      categories: [],
    })
    const removeQueries = vi.spyOn(queryClient, "removeQueries")
    const token = createOwnerServerDeleteRouteToken()

    beginOwnerServerDelete(deletedServerId, token)
    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([])
    expect(commitOwnerServerDelete(deletedServerId, token)).toBe(true)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(true)

    expect(queryClient.getQueryState(communityKeys.server(deletedServerId))).toBeUndefined()
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(flushOwnerServerDeleteAfterSuccess(queryClient, deletedServerId)).toBe(false)
    expect(flushOwnerServerDeleteRouteCommit(queryClient)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(1)
  })

  it("uses the latest committed route fact at DELETE success", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server(deletedServerId), {
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
