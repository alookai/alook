import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"

const queryClient = vi.hoisted(() => ({
  id: "query-client",
  invalidateQueries: vi.fn(() => Promise.resolve()),
}))
const createQueryClient = vi.hoisted(() => vi.fn(() => queryClient))
const seedPersistedMessageProfiles = vi.hoisted(() => vi.fn())
const setReconcileScheduler = vi.hoisted(() => vi.fn())
const getAccountUnreadProjection = vi.hoisted(() => vi.fn(() => ({
  setReconcileScheduler,
})))
const disposeAccountUnreadProjection = vi.hoisted(() => vi.fn())

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
vi.mock("@/lib/community/profile-seed", () => ({ seedPersistedMessageProfiles }))
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
  seedPersistedMessageProfiles.mockClear()
  setReconcileScheduler.mockClear()
  getAccountUnreadProjection.mockClear()
  disposeAccountUnreadProjection.mockClear()
  queryClient.invalidateQueries.mockClear()
})

describe("QueryProvider profile account lifecycle", () => {
  it("does not activate the profile account while rendering", () => {
    const store = useCommunityWsStore.getState()
    store.activateProfileAccount("viewer-a")
    const activateProfileAccountSpy = vi.fn(store.activateProfileAccount)
    useCommunityWsStore.setState({ activateProfileAccount: activateProfileAccountSpy })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          QueryProvider,
          { userId: "viewer-a" },
          React.createElement("span", null, "content"),
        ),
      ))
    })

    expect(activateProfileAccountSpy).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it("restores persisted profiles against the already-active account epoch", async () => {
    const store = useCommunityWsStore.getState()
    store.activateProfileAccount("viewer-b")
    const expectedSnapshot = store.beginProfileSnapshot()

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryProvider,
        { userId: "viewer-b" },
        React.createElement("span", null, "content"),
      ))
      await Promise.resolve()
    })

    expect(seedPersistedMessageProfiles).toHaveBeenCalledWith(queryClient, expectedSnapshot)
    act(() => renderer.unmount())
  })

  it("routes projection reconciliation through the canonical source prefixes", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        QueryProvider,
        { userId: "viewer-c" },
        React.createElement("span", null, "content"),
      ))
    })

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
    act(() => renderer.unmount())
  })
})
