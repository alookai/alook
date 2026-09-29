/**
 * Server-mutation tests. Same shim pattern as messages.test.ts / friends.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
  onSettled?: (data: unknown, err: unknown, args: Args, ctx: Ctx) => unknown
}
let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args, ctx)
    cfg.onSettled?.(data, undefined, args, ctx)
    return { data, ctx }
  } catch (err) {
    cfg.onError?.(err, args, ctx)
    cfg.onSettled?.(undefined, err, args, ctx)
    throw err
  }
}

async function load() {
  vi.resetModules()
  return await import("./servers")
}

async function registerServerRow(id = "srv_1") {
  const collections = await import("@/lib/community-db/collections")
  const registry = collections.createCommunityDbRegistry(capturedQc, "viewer")
  const unregister = collections.registerCommunityDbRegistry(registry)
  await registry.ensureCollectionReady("servers")
  registry.collections.servers.utils.writeInsert({
    id,
    position: 0,
    name: "old",
    discriminator: "0001",
    description: "old description",
    ownerId: "viewer",
    icon: null,
    official: false,
    isOwner: true,
    unread: false,
    mentions: 0,
    detailComplete: false,
  })
  return { registry, unregister }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useLeaveServer — optimistic + rollback", () => {
  it.each(["leave", "delete"] as const)(
    "%s restores the canonical server row after an optimistic failure",
    async (operation) => {
      const mod = await load()
      const canonical = await registerServerRow()
      if (operation === "leave") mod.useLeaveServer()
      else {
        const lifecycle = await import("@/lib/community/eject-server")
        mod.useDeleteServer({ routeToken: lifecycle.createOwnerServerDeleteRouteToken() })
      }
      const cfg = capturedConfig as MutConfig<{ serverId: string }, unknown>
      const args = { serverId: "srv_1" }

      const context = await cfg.onMutate?.(args)
      expect(canonical.registry.collections.servers.has("srv_1")).toBe(false)
      cfg.onError?.(new Error("failed"), args, context)
      expect(canonical.registry.collections.servers.get("srv_1")?.name).toBe("old")

      canonical.unregister()
      await canonical.registry.cleanup()
    },
  )

  it("fences every unread source in the departing scope and rolls back atomically", async () => {
    const mod = await load()
    const { getActiveAccountUnreadProjection } = await import(
      "@/hooks/community/account-unread-projection"
    )
    const projection = getActiveAccountUnreadProjection(capturedQc)
    projection.recordArrival({ channelId: "c1", serverId: "srv_1", seq: 1 })
    projection.recordArrival({ channelId: "c2", serverId: "srv_2", seq: 1 })
    mod.useLeaveServer()
    const cfg = capturedConfig as MutConfig<
      { serverId: string },
      { token: unknown; snapshot: unknown }
    >
    const context = await cfg.onMutate?.({ serverId: "srv_1" })
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("servers", "c2", false)).toBe(true)
    cfg.onError?.(new Error("failed"), { serverId: "srv_1" }, context)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it.each(["leave", "delete"] as const)("%s removes the server row and restores on failure", async (operation) => {
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [
        { id: "srv_1", name: "n", initial: "N", active: false, unread: false, mentions: 0 },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    if (operation === "leave") mod.useLeaveServer()
    else {
      const lifecycle = await import("@/lib/community/eject-server")
      mod.useDeleteServer({ routeToken: lifecycle.createOwnerServerDeleteRouteToken() })
    }
    await runMutation({ serverId: "srv_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ servers: { id: string }[] }>(serversCollectionQueryKey())
    expect(cache?.servers).toHaveLength(1)
  })

  it.each(["leave", "delete"] as const)(
    "%s success clears the server subtree, stream, and current private route",
    async (operation) => {
      apiFetchMock.mockResolvedValueOnce(undefined)
      const mod = await load()
      const { useCommunityStore } = await import("@/stores/community")
      const { useMessageStreamStore } = await import("@/stores/community/message-stream")
      useCommunityStore.getState().reset()
      useCommunityStore.getState().setCurrentServerId("srv_1")
      useCommunityStore.getState().setCurrentChannelId("private_child")
      useCommunityStore.getState().setCurrentChannelMeta({
        name: "Private title",
        parentChannelId: "private_parent",
      })
      useMessageStreamStore.getState().dispatch(
        { kind: "channel", id: "private_child", serverId: "srv_1" },
        {
          type: "wsMessage",
          message: {
            id: "message_1",
            type: "chat",
            authorId: "user_1",
            authorName: "User",
            content: "Private content",
          },
        },
      )
      const detailKey = serverDetailResourceKey("viewer", "srv_1")
      capturedQc.setQueryData(detailKey, {
        serverId: "srv_1",
        categories: [],
        channels: [],
      })
      if (operation === "leave") mod.useLeaveServer()
      else {
        const lifecycle = await import("@/lib/community/eject-server")
        mod.useDeleteServer({ routeToken: lifecycle.createOwnerServerDeleteRouteToken() })
      }

      await runMutation({ serverId: "srv_1" })
      if (operation === "delete") {
        expect(useCommunityStore.getState().currentServerId).toBe("srv_1")
        const { flushOwnerServerDeleteRouteCommit } = await import(
          "@/hooks/community/community-ws/scope-eviction"
        )
        const { observeOwnerServerDeleteRouteCommit } = await import(
          "@/lib/community/eject-server"
        )
        expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual(["srv_1"])
        expect(flushOwnerServerDeleteRouteCommit(capturedQc)).toEqual(["srv_1"])
      }

      expect(useCommunityStore.getState()).toMatchObject({
        currentServerId: null,
        currentChannelId: null,
        currentChannelMeta: null,
      })
      expect(capturedQc.getQueryState(detailKey)).toBeUndefined()
      expect([...useMessageStreamStore.getState().entries.values()]
        .some((entry) => entry.scope.serverId === "srv_1")).toBe(false)
      if (operation === "delete") {
        const lifecycle = await import("@/lib/community/eject-server")
        expect(lifecycle.isOwnerServerDeleteRouteProtected("srv_1")).toBe(false)
      }
    },
  )
})

describe("useDeleteServer — navigation lifecycle", () => {
  it("reports zero navigation and flushes once when a safe route committed before success", async () => {
    const args = { serverId: "srv_delete_after_safe_commit" }
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [{ id: args.serverId }],
    })
    const detailKey = serverDetailResourceKey("viewer", args.serverId)
    capturedQc.setQueryData(detailKey, {
      serverId: args.serverId,
      categories: [],
      channels: [],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    const lifecycle = await import("@/lib/community/eject-server")
    const routeToken = lifecycle.createOwnerServerDeleteRouteToken()
    const onSuccess = vi.fn()
    mod.useDeleteServer({ routeToken, onSuccess })
    const { flushOwnerServerDeleteRouteCommit } = await import(
      "@/hooks/community/community-ws/scope-eviction"
    )
    lifecycle.cancelOwnerServerDelete(args.serverId)
    const removeQueries = vi.spyOn(capturedQc, "removeQueries")
    const cfg = capturedConfig as MutConfig<typeof args, unknown>

    const context = await cfg.onMutate?.(args)
    expect(lifecycle.observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([])
    expect(flushOwnerServerDeleteRouteCommit(capturedQc)).toEqual([])
    expect(capturedQc.getQueryState(detailKey)).toBeDefined()
    await cfg.mutationFn?.(args)
    cfg.onSuccess?.(undefined, args, context)

    expect(capturedQc.getQueryState(detailKey)).toBeUndefined()
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(args, { needsNavigation: false })
    expect(flushOwnerServerDeleteRouteCommit(capturedQc)).toEqual([])
    expect(removeQueries).toHaveBeenCalledTimes(1)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId)).toBe(false)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId, routeToken)).toBe(true)
  })

  it("requests one navigation while the deleted route remains committed", async () => {
    const args = { serverId: "srv_delete" }
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [{ id: args.serverId }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    const lifecycle = await import("@/lib/community/eject-server")
    const routeToken = lifecycle.createOwnerServerDeleteRouteToken()
    const onSuccess = vi.fn()
    mod.useDeleteServer({ routeToken, onSuccess })
    lifecycle.cancelOwnerServerDelete(args.serverId)
    const cfg = capturedConfig as MutConfig<typeof args, unknown>

    const context = await cfg.onMutate?.(args)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId)).toBe(true)
    expect(capturedQc.getQueryData<{ servers: unknown[] }>(
      serversCollectionQueryKey(),
    )?.servers).toEqual([{ id: args.serverId }])
    await cfg.mutationFn?.(args)

    cfg.onSuccess?.(undefined, args, context)
    expect(onSuccess).toHaveBeenCalledWith(args, { needsNavigation: true })
    expect(lifecycle.claimOwnerServerDeleteNavigation(
      args.serverId,
      routeToken,
      "/c/me",
    )).toBe(true)
    const { flushOwnerServerDeleteRouteCommit } = await import(
      "@/hooks/community/community-ws/scope-eviction"
    )
    expect(lifecycle.observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([
      args.serverId,
    ])
    expect(flushOwnerServerDeleteRouteCommit(capturedQc)).toEqual([
      args.serverId,
    ])
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId)).toBe(false)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId, routeToken)).toBe(true)
  })

  it("restores the Server row and clears coordination after DELETE failure", async () => {
    const args = { serverId: "srv_delete_failed" }
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [{ id: args.serverId }],
    })
    const mod = await load()
    const lifecycle = await import("@/lib/community/eject-server")
    const routeToken = lifecycle.createOwnerServerDeleteRouteToken()
    const onError = vi.fn()
    mod.useDeleteServer({ routeToken, onError })
    lifecycle.cancelOwnerServerDelete(args.serverId)
    const cfg = capturedConfig as MutConfig<typeof args, unknown>

    const context = await cfg.onMutate?.(args)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId)).toBe(true)
    const failure = new Error("failed")
    cfg.onError?.(failure, args, context)

    expect(capturedQc.getQueryData<{ servers: Array<{ id: string }> }>(
      serversCollectionQueryKey(),
    )?.servers).toEqual([{ id: args.serverId }])
    expect(onError).toHaveBeenCalledWith(failure, args)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId)).toBe(false)
    expect(lifecycle.isOwnerServerDeleteRouteProtected(args.serverId, routeToken)).toBe(false)
    lifecycle.observeOwnerServerDeleteRouteCommit("/c/me")
    expect(lifecycle.claimOwnerServerDeleteScopeFlush(args.serverId)).toBe(false)
  })
})

describe("useUpdateServer — rollback on both caches", () => {
  it("updates and restores the canonical server row around a failed request", async () => {
    const mod = await load()
    const canonical = await registerServerRow()
    mod.useUpdateServer()
    const cfg = capturedConfig as MutConfig<{
      serverId: string
      name: string
      description: string
    }, unknown>
    const args = { serverId: "srv_1", name: "new", description: "new description" }

    const context = await cfg.onMutate?.(args)
    expect(canonical.registry.collections.servers.get("srv_1")).toMatchObject({
      name: "new",
      description: "new description",
    })
    cfg.onError?.(new Error("failed"), args, context)
    expect(canonical.registry.collections.servers.get("srv_1")).toMatchObject({
      name: "old",
      description: "old description",
    })

    canonical.unregister()
    await canonical.registry.cleanup()
  })

  it("restores server-detail + servers-list on failure", async () => {
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "old",
      description: "d",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [
        {
          id: "srv_1",
          name: "old",
          description: "d",
          initial: "O",
          active: false,
          unread: false,
          mentions: 0,
        },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useUpdateServer()
    await runMutation({ serverId: "srv_1", name: "new", description: "d2" }).catch(() => {})
    const detail = capturedQc.getQueryData<{ name: string }>(communityKeys.server("srv_1"))
    expect(detail?.name).toBe("old")
    const list = capturedQc.getQueryData<{ servers: { name: string; description: string }[] }>(
      serversCollectionQueryKey(),
    )
    expect(list?.servers[0]).toMatchObject({ name: "old", description: "d" })
  })

  it("does not rewrite the transport document during an optimistic detail update", async () => {
    const untouchedServer = {
      id: "srv_2",
      name: "untouched",
      description: "unchanged description",
      initial: "U",
      active: false,
      mentions: 4,
    }
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "old",
      description: "old description",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [
        {
          id: "srv_1",
          name: "old",
          description: "old description",
          initial: "O",
          active: false,
          mentions: 0,
        },
        untouchedServer,
      ],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useUpdateServer()

    await runMutation({
      serverId: "srv_1",
      name: "new",
      description: "new description",
    })

    expect(capturedQc.getQueryData(communityKeys.server("srv_1"))).toMatchObject({
      name: "old",
      description: "old description",
    })
    const list = capturedQc.getQueryData<{
      servers: Array<{ name: string; description: string; initial: string; mentions: number }>
    }>(serversCollectionQueryKey())?.servers
    expect(list?.[0]).toMatchObject({
      name: "old",
      description: "old description",
      initial: "O",
    })
    expect(list?.[1]).toBe(untouchedServer)
    expect(list?.[1]).toMatchObject({
      name: "untouched",
      description: "unchanged description",
      initial: "U",
      mentions: 4,
    })
  })

  it("invalidates the channel-ref directory after settling", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useUpdateServer()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")

    await runMutation({ serverId: "srv_1", name: "new", description: "updated" })

    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
  })
})

describe("useCreateServer — invalidates the server row transport", () => {
  it("fires invalidateQueries after success", async () => {
    apiFetchMock.mockResolvedValueOnce({ server: { id: "srv_new" } })
    const mod = await load()
    mod.useCreateServer()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ name: "n" })
    expect(spy).toHaveBeenCalledWith({
      queryKey: serversCollectionQueryKey(),
      exact: true,
    })
  })
})

describe("useJoinServer — refreshes canonical or transport ownership", () => {
  it("invalidates the transport when no registry is bound", async () => {
    apiFetchMock.mockResolvedValueOnce({ serverId: "joined" })
    const mod = await load()
    mod.useJoinServer()
    const invalidate = vi.spyOn(capturedQc, "invalidateQueries")

    await runMutation({ inviteCode: "invite-token" })

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: serversCollectionQueryKey(),
      exact: true,
    })
  })

  it("requests a canonical refetch when a registry is bound", async () => {
    apiFetchMock.mockResolvedValueOnce({ serverId: "joined" })
    const mod = await load()
    const canonical = await registerServerRow()
    const refetch = vi.spyOn(canonical.registry, "requestServerRefetch").mockResolvedValue(undefined)
    mod.useJoinServer()

    await runMutation({ inviteCode: "https://example.test/c/invite/invite-token" })

    expect(refetch).toHaveBeenCalledOnce()
    canonical.unregister()
    await canonical.registry.cleanup()
  })
})

describe("useUploadServerIcon — patches caches on success", () => {
  it("does not rewrite the retired server-detail transport document", async () => {
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "n",
      description: "d",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(serversCollectionQueryKey(), {
      servers: [
        { id: "srv_1", name: "n", initial: "N", active: false, unread: false, mentions: 0, icon: null },
      ],
    })
    // Mock global fetch since uploadServerIcon uses raw fetch, not apiFetch.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ url: "https://cdn/x" }), { status: 200 })) as typeof fetch
    try {
      const mod = await load()
      mod.useUploadServerIcon()
      const file = new File([""], "icon.png", { type: "image/png" })
      await runMutation({ serverId: "srv_1", file })
      const detail = capturedQc.getQueryData<{ icon: string | null }>(communityKeys.server("srv_1"))
      expect(detail?.icon).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("writes the cache-busted icon into the canonical server row", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ url: "https://cdn/icon" }), { status: 200 })) as typeof fetch
    try {
      const mod = await load()
      const canonical = await registerServerRow()
      mod.useUploadServerIcon()
      const file = new File(["icon"], "icon.png", { type: "image/png" })

      await runMutation({ serverId: "srv_1", file })

      expect(canonical.registry.collections.servers.get("srv_1")?.icon)
        .toMatch(/^https:\/\/cdn\/icon\?t=/)
      canonical.unregister()
      await canonical.registry.cleanup()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
