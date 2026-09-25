import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, render } from "@/test/react-dom-harness"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"

const queryClient = vi.hoisted(() => ({
  id: "query-client",
  invalidateQueries: vi.fn(() => Promise.resolve()),
  getQueryData: vi.fn(() => undefined),
  removeQueries: vi.fn(),
  getQueryCache: vi.fn(() => ({
    subscribe: vi.fn(() => () => {}),
    getAll: vi.fn(() => []),
  })),
}))
const createQueryClient = vi.hoisted(() => vi.fn(() => queryClient))
const setReconcileScheduler = vi.hoisted(() => vi.fn())
const getAccountUnreadProjection = vi.hoisted(() => vi.fn(() => ({
  setReconcileScheduler,
})))
const disposeAccountUnreadProjection = vi.hoisted(() => vi.fn())
const registryCleanup = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@tanstack/react-query-persist-client", async () => {
  const { useEffect } = await import("react")
  return {
    PersistQueryClientProvider: ({
      children,
      onSuccess,
    }: {
      children: React.ReactNode
      onSuccess: () => void
    }) => {
      useEffect(() => onSuccess(), [onSuccess])
      return children
    },
  }
})
vi.mock("@/lib/query-client", () => ({ createQueryClient }))
vi.mock("@/lib/query-persister", () => ({
  createIdbPersister: vi.fn(() => ({ id: "persister" })),
  PERSIST_BUSTER: "test",
  PERSIST_MAX_AGE_MS: 1,
  shouldPersistQuery: vi.fn(() => false),
}))
vi.mock("@/lib/community-db/collections", () => ({
  createCommunityDbRegistry: vi.fn(() => ({
    id: "community-db",
    captureRestoredCollections: vi.fn(),
    hasRestoredCollection: vi.fn(() => false),
    cleanup: registryCleanup,
  })),
  registerCommunityDbRegistry: vi.fn(() => () => {}),
}))
vi.mock("@/lib/community-db/projections", () => ({
  CommunityDbProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/lib/community-db/sync", () => ({
  installCommunityDbSync: vi.fn(() => () => {}),
}))
vi.mock("@/hooks/community/community-ws/read-state-reconciliation", () => ({
  disposeAccountReadStateReconciliation: vi.fn(),
}))
vi.mock("@/hooks/community/read-coordinator", () => ({ disposeReadCoordinator: vi.fn() }))
vi.mock("@/hooks/community/account-unread-projection", () => ({
  disposeAccountUnreadProjection,
  getAccountUnreadProjection,
}))

import { QueryProvider } from "./QueryProvider"

const originalActivateProfileAccount = useCommunityWsStore.getState().activateProfileAccount

beforeEach(() => {
  useCommunityWsStore.setState({ activateProfileAccount: originalActivateProfileAccount })
  useCommunityWsStore.getState().reset()
  createQueryClient.mockClear()
  setReconcileScheduler.mockClear()
  getAccountUnreadProjection.mockClear()
  disposeAccountUnreadProjection.mockClear()
  registryCleanup.mockClear()
  queryClient.invalidateQueries.mockClear()
})

describe("QueryProvider profile account lifecycle", () => {
  it("activates the restored account after render", async () => {
    const store = useCommunityWsStore.getState()
    store.activateProfileAccount("viewer-a")
    const activateProfileAccountSpy = vi.fn(store.activateProfileAccount)
    useCommunityWsStore.setState({ activateProfileAccount: activateProfileAccountSpy })
    const observedViewerIds: Array<string | null> = []
    function Probe() {
      observedViewerIds.push(useCommunityWsStore.getState().profileViewerId)
      return null
    }

    const renderer = render(React.createElement(
      QueryProvider,
      { userId: "viewer-b" },
      React.createElement(Probe),
    ))

    expect(observedViewerIds).toEqual(["viewer-a"])
    await act(async () => { await Promise.resolve() })
    expect(activateProfileAccountSpy).toHaveBeenCalledWith("viewer-b")
    act(() => renderer.unmount())
  })

  it("revalidates durable projections after restore", async () => {
    const store = useCommunityWsStore.getState()
    store.activateProfileAccount("viewer-b")

    const renderer = render(React.createElement(
      QueryProvider,
      { userId: "viewer-b" },
      React.createElement("span", null, "content"),
    ))
    await act(async () => { await Promise.resolve() })

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.folders(),
      exact: true,
      refetchType: "active",
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.dms(),
      exact: true,
      refetchType: "active",
    })
    act(() => renderer.unmount())
  })

  it("routes projection reconciliation through the canonical source prefixes", async () => {
    const renderer = render(React.createElement(
      QueryProvider,
      { userId: "viewer-c" },
      React.createElement("span", null, "content"),
    ))

    expect(getAccountUnreadProjection).toHaveBeenCalledWith(queryClient, "viewer-c")
    const reconcile = setReconcileScheduler.mock.calls.at(-1)?.[0]
    expect(reconcile).toBeTypeOf("function")
    await act(async () => reconcile())
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.inboxUnreads(),
      exact: true,
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.inboxMentions(),
      exact: true,
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.dms(),
      exact: true,
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.servers(),
      exact: true,
    })
    const detailPredicate = queryClient.invalidateQueries.mock.calls
      .map(([filters]) => filters.predicate)
      .find((predicate) => typeof predicate === "function")
    expect(detailPredicate).toBeTypeOf("function")
    expect(detailPredicate({ queryKey: communityKeys.server("server-1") })).toBe(true)
    expect(detailPredicate({ queryKey: communityKeys.members("server-1") })).toBe(false)
    expect(detailPredicate({ queryKey: communityKeys.channelRefDirectory() })).toBe(false)
    expect(detailPredicate({ queryKey: communityKeys.server("__none__") })).toBe(false)
    expect(detailPredicate({ queryKey: communityKeys.server("__pending__") })).toBe(false)
    act(() => renderer.unmount())
  })

  it("does not manually destroy collections while descendant live queries release", async () => {
    vi.useFakeTimers()
    try {
      const renderer = render(React.createElement(
        QueryProvider,
        { userId: "viewer-d" },
        React.createElement("span", null, "content"),
      ))

      act(() => renderer.unmount())
      await act(async () => vi.runAllTimersAsync())

      expect(registryCleanup).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
