import React from "react"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"

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
  refetchQueries: vi.fn(() => Promise.resolve()),
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
  it("keeps the server pending frame in SSR output", () => {
    const html = renderToString(React.createElement(
      QueryProvider,
      {
        pending: React.createElement("span", null, "pending"),
        userId: "viewer-b",
      },
      React.createElement("span", null, "ready"),
    ))

    expect(html).toContain("pending")
    expect(html).not.toContain("ready")
    expect(mocks.getRuntime).not.toHaveBeenCalled()
  })

  it("mounts route queries while account collections are still preloading", async () => {
    let resolvePreload!: () => void
    mocks.preload.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolvePreload = resolve
    }))
    const renderer = render(React.createElement(
      QueryProvider,
      { pending: React.createElement("span", null, "pending"), userId: "viewer-b" },
      React.createElement("span", null, "ready"),
    ))

    expect(renderer.container).toHaveTextContent("pending")
    await waitFor(() => expect(mocks.preload).toHaveBeenCalledOnce())
    expect(renderer.container).toHaveTextContent("ready")
    expect(mocks.installSync).toHaveBeenCalledOnce()
    expect(mocks.capture).not.toHaveBeenCalled()
    await act(async () => resolvePreload())
    expect(renderer.container).toHaveTextContent("ready")
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(useCommunityWsStore.getState().profileViewerId).toBe("viewer-b")
    expect(mocks.installSync).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("recreates the registry in memory when persisted preload fails", async () => {
    const persisted = registry()
    persisted.preload = vi.fn(() => Promise.reject(new Error("OPFS failed")))
    const memory = registry()
    let resolveMemoryPreload!: () => void
    memory.preload = vi.fn(() => new Promise<void>((resolve) => {
      resolveMemoryPreload = resolve
    }))
    mocks.createRegistry
      .mockReturnValueOnce(persisted)
      .mockReturnValueOnce(memory)

    const renderer = render(React.createElement(
      QueryProvider,
      { pending: React.createElement("span", null, "pending"), userId: "viewer-b" },
      React.createElement("span", null, "ready"),
    ))

    await waitFor(() => expect(mocks.createRegistry).toHaveBeenCalledTimes(2))
    expect(renderer.container).toHaveTextContent("ready")
    expect(mocks.createRegistry).toHaveBeenNthCalledWith(
      1,
      queryClient,
      "viewer-b",
      { persistence: { kind: "sqlite" } },
    )
    expect(mocks.createRegistry).toHaveBeenNthCalledWith(2, queryClient, "viewer-b")
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(persisted.cleanup).not.toHaveBeenCalled()
    await act(async () => resolveMemoryPreload())
    await waitFor(() => expect(renderer.container).toHaveTextContent("ready"))
    await waitFor(() => expect(persisted.cleanup).toHaveBeenCalledOnce())
    expect(queryClient.refetchQueries).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: communityKeys.all,
      type: "active",
    }))
    expect(mocks.capture).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
