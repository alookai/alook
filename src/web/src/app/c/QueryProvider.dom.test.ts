import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { QueryClient, useQueryClient } from "@tanstack/react-query"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"

let queryClient: QueryClient
const createQueryClient = vi.hoisted(() => vi.fn())
const setReconcileScheduler = vi.hoisted(() => vi.fn())
const getAccountUnreadProjection = vi.hoisted(() => vi.fn(() => ({ setReconcileScheduler })))
const disposeAccountUnreadProjection = vi.hoisted(() => vi.fn())
const restoreResult = vi.hoisted(() => ({ current: "success" as "success" | "error" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ isPending: true, data: null, error: null }), currentSessionViewer: () => undefined }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@tanstack/react-query-persist-client", async () => {
  const { useEffect, useRef, useState } = await import("react")
  const { QueryClientProvider, IsRestoringProvider } = await import("@tanstack/react-query")
  return { PersistQueryClientProvider: ({ children, client, onSuccess, onError }: {
    children: React.ReactNode; client: QueryClient; onSuccess: () => void; onError: () => void
  }) => {
    const done = useRef(false), [restored, setRestored] = useState(false)
    useEffect(() => {
      if (done.current) return
      done.current = true
      if (restoreResult.current === "success") onSuccess(); else onError()
      setRestored(true)
    }, [onSuccess, onError])
    return React.createElement(QueryClientProvider, { client }, React.createElement(IsRestoringProvider, { value: !restored }, children))
  } }
})
vi.mock("@/lib/query-client", () => ({ createQueryClient }))
vi.mock("@/lib/query-persister", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/query-persister")>(),
  createIdbPersister: () => ({ persistClient: vi.fn(), restoreClient: vi.fn(), removeClient: vi.fn(), retireAccount: vi.fn(), isCurrent: async () => true }),
}))
vi.mock("@/lib/community-db/sync", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/sync")>(), installCommunityDbSync: () => () => undefined }))
vi.mock("@/hooks/community/account-unread-projection", async (importOriginal) => ({ ...await importOriginal<typeof import("@/hooks/community/account-unread-projection")>(), getAccountUnreadProjection, disposeAccountUnreadProjection }))
import { QueryProvider } from "./QueryProvider"

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  createQueryClient.mockReset(); createQueryClient.mockReturnValue(queryClient)
  setReconcileScheduler.mockClear(); getAccountUnreadProjection.mockClear(); disposeAccountUnreadProjection.mockClear()
  restoreResult.current = "success"
})
afterEach(async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); await getCommunityDbRegistry(queryClient)?.cleanup(); queryClient.clear()
  })
})

function mount(userId: string, children: React.ReactNode = "content", strict = false) {
  const tree = React.createElement(QueryProvider, { userId }, children)
  return render(strict ? React.createElement(React.StrictMode, null, tree) : tree)
}

describe("QueryProvider profile account lifecycle", () => {
  it("cancels retirement during Strict Mode replay and cleans up the final owner once", async () => {
    vi.useFakeTimers()
    try {
      const renderer = mount("viewer-strict", "content", true)
      const registry = getCommunityDbRegistry(queryClient)!, cleanup = vi.spyOn(registry, "cleanup")
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(cleanup).not.toHaveBeenCalled()
      act(() => renderer.unmount())
      expect(cleanup).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(cleanup).toHaveBeenCalledOnce()
      expect(registry.runtime.lifecycle.get().active).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it("owns the new account before restore while the prior owner remains isolated", async () => {
    const previous = await createCommunityQueryOwner("viewer-a")
    const observed: string[] = []
    function Probe() {
      const runtime = useCommunityRuntime(), client = useQueryClient()
      React.useLayoutEffect(() => { observed.push(runtime.ws.get().profileViewerId!); expect(client).toBe(queryClient) }, [client, runtime])
      return null
    }
    const renderer = mount("viewer-b", React.createElement(Probe))
    await waitFor(() => expect(observed).toContain("viewer-b"))
    expect(previous.registry.runtime.ws.get().profileViewerId).toBe("viewer-a")
    expect(getCommunityDbRegistry(queryClient)?.accountId).toBe("viewer-b")
    act(() => renderer.unmount())
  })
  it("revalidates durable projections after restore", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const renderer = mount("viewer-b")
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.folders(), exact: true, refetchType: "active" }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.dms(), exact: true, refetchType: "active" })
    act(() => renderer.unmount())
  })
  it("confirms the new viewer and empty canonical baseline after restore failure", async () => {
    restoreResult.current = "error"
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const renderer = mount("viewer-new")
    const registry = getCommunityDbRegistry(queryClient)!
    await registry.ready
    expect(registry.runtime.ws.get().profileViewerId).toBe("viewer-new")
    expect([...registry.collections.friendships.values()]).toEqual([])
    expect(registry.hasRestoredCollection("friendships")).toBe(false)
    expect(invalidate).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
  it("routes projection reconciliation through the canonical source prefixes", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries"), renderer = mount("viewer-c")
    expect(getAccountUnreadProjection).toHaveBeenCalledWith(queryClient, "viewer-c")
    const reconcile = setReconcileScheduler.mock.calls.at(-1)?.[0]
    expect(reconcile).toBeTypeOf("function")
    invalidate.mockClear()
    await act(async () => reconcile())
    for (const key of [communityKeys.inboxUnreads(), communityKeys.inboxMentions(), communityKeys.dms(), communityKeys.servers()]) expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true })
    const predicate = invalidate.mock.calls.map(([filters]) => filters?.predicate).find((value) => typeof value === "function")!
    const query = (queryKey: readonly unknown[]) => ({ queryKey } as Parameters<typeof predicate>[0])
    expect(predicate(query(communityKeys.server("server-1")))).toBe(true)
    for (const key of [communityKeys.members("server-1"), communityKeys.channelRefDirectory(), communityKeys.server("__none__"), communityKeys.server("__pending__")]) expect(predicate(query(key))).toBe(false)
    act(() => renderer.unmount())
  })
  it("releases collections after descendant subscriptions release on real retirement", async () => {
    vi.useFakeTimers()
    try {
      let descendantReleased = false
      function Child() { React.useLayoutEffect(() => () => { descendantReleased = true }, []); return null }
      const renderer = mount("viewer-d", React.createElement(Child))
      const registry = getCommunityDbRegistry(queryClient)!, cleanup = vi.spyOn(registry, "cleanup")
      act(() => renderer.unmount())
      expect(descendantReleased).toBe(true)
      expect(cleanup).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(cleanup).toHaveBeenCalledOnce()
      expect(queryClient.getQueryCache().getAll()).toEqual([])
    } finally { vi.useRealTimers() }
  })
})
