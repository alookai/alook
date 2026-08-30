import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useCommunityWsStore } from "@/stores/community/ws"

const queryClient = vi.hoisted(() => ({ id: "query-client" }))
const createQueryClient = vi.hoisted(() => vi.fn(() => queryClient))
const seedPersistedMessageProfiles = vi.hoisted(() => vi.fn())

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
  disposeAccountUnreadProjection: vi.fn(),
  getAccountUnreadProjection: vi.fn(),
}))

import { QueryProvider } from "./QueryProvider"

const originalActivateProfileAccount = useCommunityWsStore.getState().activateProfileAccount

beforeEach(() => {
  useCommunityWsStore.setState({ activateProfileAccount: originalActivateProfileAccount })
  useCommunityWsStore.getState().reset()
  createQueryClient.mockClear()
  seedPersistedMessageProfiles.mockClear()
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
})
