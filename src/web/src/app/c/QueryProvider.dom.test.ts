import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useCommunityWsStore } from "@/stores/community/ws"

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  cleanup: vi.fn(),
  clear: vi.fn(() => Promise.resolve()),
  createRegistry: vi.fn(),
  getRuntime: vi.fn(() => Promise.resolve({ persistence: { kind: "sqlite" } })),
  installSync: vi.fn(() => () => {}),
  preload: vi.fn(() => Promise.resolve()),
  registerClear: vi.fn(() => () => {}),
  registerRegistry: vi.fn(() => () => {}),
  setReconcileScheduler: vi.fn(),
}))

const queryClient = {
  invalidateQueries: vi.fn(() => Promise.resolve()),
}

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return {
    ...actual,
    QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/query-client", () => ({ createQueryClient: () => queryClient }))
vi.mock("@/lib/browser-persistence", () => ({
  getBrowserPersistenceRuntime: mocks.getRuntime,
  registerPersistenceClearScope: mocks.registerClear,
}))
vi.mock("@/lib/community-db/collections", () => ({
  createCommunityDbRegistry: mocks.createRegistry,
  registerCommunityDbRegistry: mocks.registerRegistry,
}))
vi.mock("@/lib/community-db/projections", () => ({
  CommunityDbProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/lib/community-db/sync", () => ({ installCommunityDbSync: mocks.installSync }))
vi.mock("@/hooks/community/community-ws/read-state-reconciliation", () => ({
  disposeAccountReadStateReconciliation: vi.fn(),
}))
vi.mock("@/hooks/community/read-coordinator", () => ({ disposeReadCoordinator: vi.fn() }))
vi.mock("@/hooks/community/account-unread-projection", () => ({
  disposeAccountUnreadProjection: vi.fn(),
  getAccountUnreadProjection: () => ({ setReconcileScheduler: mocks.setReconcileScheduler }),
}))

import { QueryProvider } from "./QueryProvider"

function registry() {
  return {
    scopeId: "viewer-b",
    clear: mocks.clear,
    cleanup: mocks.cleanup,
    preload: mocks.preload,
    captureRestoredCollections: mocks.capture,
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear()
  mocks.getRuntime.mockResolvedValue({ persistence: { kind: "sqlite" } })
  mocks.preload.mockResolvedValue(undefined)
  mocks.createRegistry.mockImplementation(() => registry())
  useCommunityWsStore.getState().reset()
})

describe("QueryProvider collection startup", () => {
  it("preloads the account collection registry before mounting children", async () => {
    let resolvePreload!: () => void
    mocks.preload.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolvePreload = resolve
    }))
    const renderer = render(React.createElement(
      QueryProvider,
      { userId: "viewer-b" },
      React.createElement("span", null, "ready"),
    ))

    expect(renderer.container).not.toHaveTextContent("ready")
    await act(async () => resolvePreload())
    await waitFor(() => expect(renderer.container).toHaveTextContent("ready"))
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(useCommunityWsStore.getState().profileViewerId).toBe("viewer-b")
    expect(mocks.installSync).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("recreates the registry in memory when persisted preload fails", async () => {
    const persisted = registry()
    persisted.preload = vi.fn(() => Promise.reject(new Error("OPFS failed")))
    const memory = registry()
    mocks.createRegistry
      .mockReturnValueOnce(persisted)
      .mockReturnValueOnce(memory)

    const renderer = render(React.createElement(
      QueryProvider,
      { userId: "viewer-b" },
      React.createElement("span", null, "ready"),
    ))

    await waitFor(() => expect(renderer.container).toHaveTextContent("ready"))
    expect(mocks.createRegistry).toHaveBeenNthCalledWith(
      1,
      queryClient,
      "viewer-b",
      { persistence: { kind: "sqlite" } },
    )
    expect(mocks.createRegistry).toHaveBeenNthCalledWith(2, queryClient, "viewer-b")
    expect(persisted.cleanup).toHaveBeenCalledOnce()
    renderer.unmount()
  })
})
