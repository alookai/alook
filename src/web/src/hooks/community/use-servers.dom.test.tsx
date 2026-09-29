import React from "react"
import { renderToString } from "react-dom/server"
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
import { useServer, useServers } from "./use-servers"

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
  it("keeps the null-server detail query disabled under its sentinel key", () => {
    const queryClient = new QueryClient()
    const view = renderHook(() => useServer(null), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    expect(view.result.current.server).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(queryClient.getQueryCache().findAll().map((query) => query.queryKey)).toContainEqual([
      "community", "db", "anon", "channel-resource", "__none__",
    ])
    view.unmount()
    queryClient.clear()
  })

  it("provides a stable empty server snapshot during SSR", () => {
    const queryClient = new QueryClient()
    const Probe = () => {
      const result = useServers()
      return <span>{result.servers.length}</span>
    }

    expect(renderToString(
      <QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>,
    )).toContain(">0<")
    queryClient.clear()
  })

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
    queryClient.clear()
  })

  it("becomes live-authoritative when canonical structure matches in any order", async () => {
    useCommunityWsStore.getState().activateProfileAccount("viewer-detail")
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/read-state")) {
        return { revision: 0, readStates: [] }
      }
      if (path.endsWith("/attention")) {
        return {
          scopes: [], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        }
      }
      if (path.endsWith("/dms")) {
        return { conversations: [] }
      }
      if (path.endsWith("/server-folders")) {
        return { folders: [] }
      }
      if (path.endsWith("/notifications")) {
        return []
      }
      if (path.endsWith("/categories")) {
        return { categories: [
          { id: "category-b", name: "B", private: false },
          { id: "category-a", name: "A", private: false },
        ] }
      }
      if (path.endsWith("/channels")) {
        return { channels: [
          { id: "channel-b", name: "B", categoryId: "category-a", type: "forum" },
          { id: "channel-a", name: "A", categoryId: "category-a", type: "text" },
        ] }
      }
      throw new Error(`unexpected ${path}`)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer-detail")
    const unregister = registerCommunityDbRegistry(registry)
    await registry.preload()
    registry.collections.servers.utils.writeInsert({
      id: "server-detail",
      position: 0,
      name: "Detail",
      discriminator: "0001",
      description: "",
      ownerId: "viewer-detail",
      icon: null,
      official: false,
      isOwner: true,
      unread: false,
      mentions: 0,
      detailComplete: false,
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CommunityDbProvider registry={registry}>{children}</CommunityDbProvider>
      </QueryClientProvider>
    )
    const view = renderHook(() => useServer("server-detail"), { wrapper })

    await waitFor(() => expect(view.result.current.isLiveAuthoritative).toBe(true))
    expect(view.result.current.server?.categories.map((category) => category.id))
      .toEqual(["category-b", "category-a"])

    view.unmount()
    unregister()
    queryClient.clear()
  })
})
