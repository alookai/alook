import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useServers } from "./use-servers"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) }
})

afterEach(() => {
  vi.clearAllMocks()
  useCommunityWsStore.getState().reset()
})

describe("useServers official collection observer", () => {
  it("preserves the collection query function across mounts and refetches", async () => {
    useCommunityWsStore.getState().activateProfileAccount("viewer-hook-regression")
    apiFetch.mockResolvedValue({
      servers: [{
        id: "server-1",
        name: "Alook",
        discriminator: "0001",
        description: "Home",
        ownerId: "viewer-hook-regression",
        icon: null,
        official: true,
        role: "owner",
      }],
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const registry = createCommunityDbRegistry(
      queryClient,
      "viewer-hook-regression",
      { serverTransport: true },
    )
    const unregister = registerCommunityDbRegistry(registry)
    await registry.ensureCollectionReady("servers")
    expect(typeof queryClient.getQueryCache().find({
      queryKey: serversCollectionQueryKey(),
    })?.options.queryFn).toBe("function")

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CommunityDbProvider registry={registry}>{children}</CommunityDbProvider>
      </QueryClientProvider>
    )
    const view = renderHook(() => useServers(), { wrapper })

    await waitFor(() => {
      expect(view.result.current.isSuccess).toBe(true)
      expect(view.result.current.servers.map((server) => server.id)).toEqual(["server-1"])
    })
    expect(typeof queryClient.getQueryCache().find({
      queryKey: serversCollectionQueryKey(),
    })?.options.queryFn).toBe("function")

    await registry.requestServerRefetch()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryState(serversCollectionQueryKey())?.status).toBe("success")

    view.unmount()
    unregister()
    registry["cleanup"]()
    queryClient.clear()
  })
})
