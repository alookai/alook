import React, { StrictMode } from "react"
import { QueryClient, useQuery } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  createRegistry: vi.fn(),
  getRuntime: vi.fn(() => Promise.resolve({ persistence: null })),
  preload: vi.fn(() => new Promise<void>(() => {})),
  registerClear: vi.fn(() => () => {}),
  registerRegistry: vi.fn(() => () => {}),
  setReconcileScheduler: vi.fn(),
}))

vi.mock("@/lib/query-client", () => ({
  createQueryClient: () => new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
}))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
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
vi.mock("@/lib/community-db/sync", () => ({ installCommunityDbSync: () => () => {} }))
vi.mock("@/hooks/community/community-ws/read-state-reconciliation", () => ({
  disposeAccountReadStateReconciliation: vi.fn(),
}))
vi.mock("@/hooks/community/read-coordinator", () => ({ disposeReadCoordinator: vi.fn() }))
vi.mock("@/hooks/community/account-unread-projection", () => ({
  disposeAccountUnreadProjection: vi.fn(),
  getAccountUnreadProjection: () => ({ setReconcileScheduler: mocks.setReconcileScheduler }),
}))

import { QueryProvider } from "./QueryProvider"

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear()
  mocks.getRuntime.mockResolvedValue({ persistence: null })
  mocks.preload.mockReturnValue(new Promise<void>(() => {}))
  mocks.createRegistry.mockImplementation(() => ({
    scopeId: "viewer",
    clear: vi.fn(() => Promise.resolve()),
    cleanup: mocks.cleanup,
    preload: mocks.preload,
  }))
})

describe("QueryProvider strict-mode startup", () => {
  it("does not abort and restart a route query while preload remains pending", async () => {
    let attempts = 0
    const Probe = () => {
      useQuery({
        queryKey: ["community", "strict-startup"],
        queryFn: ({ signal }) => new Promise<string>((resolve, reject) => {
          attempts += 1
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          void resolve
        }),
      })
      return <span>route</span>
    }
    const renderer = render(
      <StrictMode>
        <QueryProvider pending={<span>pending</span>} userId="viewer">
          <Probe />
        </QueryProvider>
      </StrictMode>,
    )

    await waitFor(() => expect(renderer.container).toHaveTextContent("route"))
    await waitFor(() => expect(attempts).toBe(1))
    renderer.unmount()
  })
})
