import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import {
  cancelOwnerServerDelete,
  claimOwnerServerDeleteNavigation,
  claimOwnerServerDeleteScopeFlush,
  completeOwnerServerDeleteScopeFlush,
  createOwnerServerDeleteRouteToken,
  isOwnerServerDeleteRouteProtected,
  observeOwnerServerDeleteRouteCommit,
} from "@/lib/community/eject-server"
import { useDeleteServer } from "./servers"

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  evictServerChannelScopes: vi.fn(),
  flushOwnerServerDeleteAfterSuccess: vi.fn(),
}))

vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.api,
  readUploadError: vi.fn(),
}))

vi.mock("@/hooks/community/community-ws/scope-eviction", () => ({
  evictServerChannelScopes: mocks.evictServerChannelScopes,
  flushOwnerServerDeleteAfterSuccess: mocks.flushOwnerServerDeleteAfterSuccess,
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(
  serverId: string,
  callbacks: Parameters<typeof useDeleteServer>[0],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(communityKeys.servers(), {
    servers: [{ id: serverId }],
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return {
    client,
    ...renderHook(
      ({ activeCallbacks }) => useDeleteServer(activeCallbacks),
      { initialProps: { activeCallbacks: callbacks }, wrapper },
    ),
  }
}

describe("useDeleteServer — unmounted caller", () => {
  const serverIds = [
    "srv_unmounted_success",
    "srv_unmounted_failure",
    "srv_rerendered_success",
  ]

  beforeEach(() => {
    mocks.api.mockReset()
    mocks.evictServerChannelScopes.mockReset()
    mocks.flushOwnerServerDeleteAfterSuccess.mockReset()
    for (const serverId of serverIds) cancelOwnerServerDelete(serverId)
  })

  afterEach(() => {
    for (const serverId of serverIds) cancelOwnerServerDelete(serverId)
  })

  it("keeps the successful navigation handoff after the calling component unmounts", async () => {
    const serverId = serverIds[0]
    const request = deferred<void>()
    const onSuccess = vi.fn()
    const routeToken = createOwnerServerDeleteRouteToken()
    mocks.api.mockReturnValueOnce(request.promise)
    const view = setup(serverId, { routeToken, onSuccess })

    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledOnce()
      expect(view.client.getQueryData<{ servers: unknown[] }>(
        communityKeys.servers(),
      )?.servers).toEqual([])
      expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(true)
    })
    view.unmount()

    request.resolve(undefined)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(onSuccess).toHaveBeenCalledWith({ serverId }, { needsNavigation: true })
    expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(true)
    expect(claimOwnerServerDeleteNavigation(serverId, routeToken, "/c/me")).toBe(true)

    observeOwnerServerDeleteRouteCommit("/c/me")
    expect(claimOwnerServerDeleteScopeFlush(serverId)).toBe(true)
    expect(completeOwnerServerDeleteScopeFlush(serverId)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, routeToken)).toBe(true)
  })

  it("rolls back and clears coordination before reporting an unmounted failure", async () => {
    const serverId = serverIds[1]
    const request = deferred<void>()
    const failure = new Error("delete failed")
    const routeToken = createOwnerServerDeleteRouteToken()
    const clientRef: { current: QueryClient | null } = { current: null }
    const onError = vi.fn(() => {
      expect(clientRef.current?.getQueryData<{ servers: Array<{ id: string }> }>(
        communityKeys.servers(),
      )?.servers).toEqual([{ id: serverId }])
      expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(false)
    })
    mocks.api.mockReturnValueOnce(request.promise)
    const view = setup(serverId, { routeToken, onError })
    clientRef.current = view.client

    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledOnce()
      expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(true)
    })
    view.unmount()

    request.reject(failure)
    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(failure, { serverId })
    observeOwnerServerDeleteRouteCommit("/c/me")
    expect(claimOwnerServerDeleteScopeFlush(serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, routeToken)).toBe(false)
  })

  it("finishes with the originating token and callback after the route layout rerenders", async () => {
    const serverId = serverIds[2]
    const request = deferred<void>()
    const originToken = createOwnerServerDeleteRouteToken()
    const survivorToken = createOwnerServerDeleteRouteToken()
    const originSuccess = vi.fn()
    const survivorSuccess = vi.fn()
    mocks.api.mockReturnValueOnce(request.promise)
    const view = setup(serverId, { routeToken: originToken, onSuccess: originSuccess })

    act(() => view.result.current.mutate({ serverId }))
    await waitFor(() => expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(true))
    observeOwnerServerDeleteRouteCommit("/c/channels/survivor/channel-1")
    view.rerender({
      activeCallbacks: { routeToken: survivorToken, onSuccess: survivorSuccess },
    })

    request.resolve(undefined)
    await waitFor(() => expect(originSuccess).toHaveBeenCalledOnce())
    expect(originSuccess).toHaveBeenCalledWith({ serverId }, { needsNavigation: false })
    expect(survivorSuccess).not.toHaveBeenCalled()
    expect(mocks.flushOwnerServerDeleteAfterSuccess).toHaveBeenCalledWith(
      view.client,
      serverId,
    )
  })
})
