import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { runAuthoritativeServerEject } from "@/lib/community/eject-server"
import { communityKeys } from "@/lib/query-keys"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"

const projection = vi.hoisted(() => ({
  rail: undefined as undefined | {
    servers: Array<{
      id: string
      name: string
      discriminator: string
      description: string
      ownerId: string
      initial: string
      active: boolean
      unread: boolean
      mentions: number
      isOwner: boolean
      icon: string | null
      official: boolean
    }>
  },
  registry: null as null | {
    isCollectionReady: (name: string) => boolean
    requestServerRefetch: () => Promise<void>
  },
}))

vi.mock("@/lib/community-db/projections", () => ({
  useAttentionScopes: () => [],
  useOptionalCommunityDbRegistry: () => projection.registry,
  useServerRailProjection: () => projection.rail,
  useServerTreeProjection: () => undefined,
}))

import { useServers } from "./use-servers"

beforeEach(() => {
  projection.rail = undefined
  projection.registry = null
})

describe("useServers network-to-collection commit gap", () => {
  it("does not make successful transport authoritative before its rows are projected", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryFn = vi.fn(async () => ({
      servers: [{
        id: "server-1",
        position: 0,
        name: "Alook",
        discriminator: "0001",
        description: "Home",
        ownerId: "viewer",
        icon: null,
        official: true,
        isOwner: true,
        unread: false,
        mentions: 0,
        detailComplete: false,
      }],
      unreadSources: [],
    }))
    projection.registry = {
      isCollectionReady: () => true,
      requestServerRefetch: async () => {
        await queryClient.refetchQueries({ queryKey: serversCollectionQueryKey(), exact: true })
      },
    }
    await queryClient.fetchQuery({ queryKey: serversCollectionQueryKey(), queryFn })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const view = renderHook(() => useServers(), { wrapper })

    expect(view.result.current.isSuccess).toBe(false)
    expect(view.result.current.isFetching).toBe(true)
    const replace = vi.fn()
    expect(runAuthoritativeServerEject({
      serverId: "server-1",
      servers: view.result.current.servers,
      isSuccess: view.result.current.isSuccess,
      isFetching: view.result.current.isFetching,
      consumeVoluntaryLeave: () => false,
      clearLastChannel: vi.fn(),
      toast: vi.fn(),
      replace,
    })).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(typeof queryClient.getQueryCache().find({
      queryKey: serversCollectionQueryKey(),
    })?.options.queryFn).toBe("function")

    projection.rail = {
      servers: [{
        id: "server-1",
        name: "Alook",
        discriminator: "0001",
        description: "Home",
        ownerId: "viewer",
        initial: "A",
        active: false,
        unread: false,
        mentions: 0,
        isOwner: true,
        icon: null,
        official: true,
      }],
    }
    view.rerender()
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))

    await view.result.current.refetch()
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(typeof queryClient.getQueryCache().find({
      queryKey: serversCollectionQueryKey(),
    })?.options.queryFn).toBe("function")

    view.unmount()
    queryClient.clear()
  })

  it("defers Query cache notifications raised during a sibling render", async () => {
    const queryClient = new QueryClient()
    const response = {
      servers: [{
        id: "server-1",
        position: 0,
        name: "Alook",
        discriminator: "0001",
        description: "Home",
        ownerId: "viewer",
        icon: null,
        official: true,
        isOwner: true,
        unread: false,
        mentions: 0,
        detailComplete: false,
      }],
      unreadSources: [],
    }
    projection.registry = {
      isCollectionReady: () => true,
      requestServerRefetch: async () => {},
    }
    projection.rail = {
      servers: [{
        id: "server-1",
        name: "Alook",
        discriminator: "0001",
        description: "Home",
        ownerId: "viewer",
        initial: "A",
        active: false,
        unread: false,
        mentions: 0,
        isOwner: true,
        icon: null,
        official: true,
      }],
    }
    queryClient.setQueryData(serversCollectionQueryKey(), response)
    const errors: string[] = []
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "))
    })
    const Subscriber = () => {
      useServers()
      return null
    }
    const RenderPhaseTransportUpdate = ({ update }: { update: boolean }) => {
      if (update) queryClient.setQueryData(serversCollectionQueryKey(), { ...response })
      return null
    }
    const App = ({ update }: { update: boolean }) => (
      <QueryClientProvider client={queryClient}>
        <Subscriber />
        <RenderPhaseTransportUpdate update={update} />
      </QueryClientProvider>
    )
    const view = render(<App update={false} />)

    view.rerender(<App update />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(errors.join("\n")).not.toContain("Cannot update a component while rendering")
    consoleError.mockRestore()
    view.unmount()
    queryClient.clear()
  })
})
