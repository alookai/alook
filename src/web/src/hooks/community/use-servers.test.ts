import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
    useMemo: <T,>(factory: () => T) => factory(),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
})

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type CapturedQueryConfig = {
  enabled?: boolean
  queryFn?: () => unknown
}
let capturedQueryConfig: CapturedQueryConfig | null = null
let capturedHookQueryClient: QueryClient
let capturedHookQueryData: unknown
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedHookQueryClient,
    useQuery: (config: CapturedQueryConfig) => {
      capturedQueryConfig = config
      return { data: capturedHookQueryData }
    },
  }
})

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedQueryConfig = null
  capturedHookQueryClient = new QueryClient()
  capturedHookQueryData = undefined
})

describe("useServers / serversQueryFn", () => {
  it("materialises raw server rows into render-ready Server shape", async () => {
    apiFetchMock.mockResolvedValueOnce({
      servers: [
        {
          id: "srv_1",
          name: "Alook",
          discriminator: "0042",
          description: "Build together",
          icon: null,
          ownerId: "u_1",
          role: "owner",
          mentions: 3,
          unread: true,
        },
        { id: "srv_2", name: "Beta", discriminator: "12345", icon: null, role: "member" },
      ],
    })
    const { serversQueryFn } = await import("./use-servers")
    const data = await serversQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", { signal: undefined })
    expect(data.servers[0].initial).toBe("A")
    expect(data.servers[0].isOwner).toBe(true)
    expect(data.servers[0].mentions).toBe(3)
    expect(data.servers[0].active).toBe(false)
    expect(data.servers[0].discriminator).toBe("0042")
    expect(data.servers[0].description).toBe("Build together")
    expect(data.servers[0].ownerId).toBe("u_1")
    expect(data.servers[0].unread).toBe(true)
    expect(data.servers[1].mentions).toBe(0)
    expect(data.servers[1].isOwner).toBe(false)
    expect(data.servers[1].unread).toBe(false)
  })

  it("preserves mentions when provided; defaults to 0 when omitted", async () => {
    apiFetchMock.mockResolvedValueOnce({
      servers: [
        { id: "srv_1", name: "A", discriminator: "0001", icon: null, mentions: 7 },
        { id: "srv_2", name: "B", discriminator: "0002", icon: null }, // no mentions key
      ],
    })
    const { serversQueryFn } = await import("./use-servers")
    const data = await serversQueryFn()
    expect(data.servers[0].mentions).toBe(7)
    expect(data.servers[1].mentions).toBe(0)
  })

  it("passes TanStack's abort signal to the canonical request", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const controller = new AbortController()
    const { serversQueryFn } = await import("./use-servers")

    await serversQueryFn({ signal: controller.signal } as never)

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", {
      signal: controller.signal,
    })
  })

  it("populates queryClient at communityKeys.servers()", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const { serversQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    const key = communityKeys.servers()
    await qc.fetchQuery({ queryKey: key, queryFn: serversQueryFn })
    expect(qc.getQueryData(key)).toEqual({ servers: [] })
  })

  it("projects a live unread arrival and preserves unchanged server identity", async () => {
    const changed = {
      id: "s1",
      unread: false,
      mentions: 0,
      unreadSources: [],
      mentionSources: [],
    }
    const unchanged = {
      id: "s2",
      unread: true,
      mentions: 2,
      unreadSources: [{ channelId: "c2", lastUnreadSeq: 2 }],
      mentionSources: [{ channelId: "c2", count: 2, lastSeq: 2 }],
    }
    const legacy = { id: "s3", unread: true, mentions: 0 }
    const raw = [changed, unchanged, legacy]
    capturedHookQueryData = { servers: raw }
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    getActiveAccountUnreadProjection(capturedHookQueryClient).recordArrival({
      channelId: "c1",
      serverId: "s1",
      seq: 1,
    })
    const { useServers } = await import("./use-servers")

    const result = useServers()

    expect(result.servers).not.toBe(raw)
    expect(result.servers[0]).not.toBe(changed)
    expect(result.servers[0]?.unread).toBe(true)
    expect(result.servers[1]).toBe(unchanged)
    expect(result.servers[2]).toBe(legacy)
  })

  it("returns the frozen empty server list before query data arrives", async () => {
    const { useServers } = await import("./use-servers")
    const first = useServers().servers
    const second = useServers().servers
    expect(first).toBe(second)
    expect(first).toEqual([])
  })

  it("retains a rolling-deploy rail unread without a source vector", async () => {
    capturedHookQueryData = {
      servers: [{ id: "s1", unread: true, mentions: 0 }],
    }
    const { useServers } = await import("./use-servers")
    expect(useServers().servers[0]?.unread).toBe(true)

    capturedHookQueryData = {
      servers: [{ id: "s1", unread: false, mentions: 0 }],
    }
    expect(useServers().servers[0]?.unread).toBe(true)
  })

  it("hands a rolling-deploy rail unread to exact sources once they arrive", async () => {
    capturedHookQueryData = {
      servers: [{ id: "s1", unread: true, mentions: 0 }],
    }
    const { useServers } = await import("./use-servers")
    expect(useServers().servers[0]?.unread).toBe(true)

    capturedHookQueryData = {
      servers: [{
        id: "s1",
        unread: true,
        mentions: 0,
        unreadSources: [{ channelId: "c1", lastUnreadSeq: 4 }],
      }],
    }
    expect(useServers().servers[0]?.unread).toBe(true)

    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    getActiveAccountUnreadProjection(capturedHookQueryClient).acceptPrimarySnapshot({
      revision: 1,
      readStates: [{ channelId: "c1", lastReadSeq: 4 }],
    })
    expect(useServers().servers[0]?.unread).toBe(false)
  })
})

describe("useServer / serverQueryFn", () => {
  it("keeps the null-server query disabled without issuing API requests", async () => {
    const { useServer } = await import("./use-servers")

    useServer(null)

    expect(capturedQueryConfig?.enabled).toBe(false)
    const disabledQueryFn = capturedQueryConfig?.queryFn
    expect(disabledQueryFn).toBeTypeOf("function")
    await expect(disabledQueryFn?.()).rejects.toThrow("disabled")
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("projects server-detail channels while preserving unchanged category paths", async () => {
    const changedChannel = { id: "c1", unread: false }
    const unchangedChannel = { id: "c2", unread: true }
    const changedCategory = { id: "cat1", channels: [changedChannel] }
    const unchangedCategory = { id: "cat2", channels: [unchangedChannel] }
    const detail = {
      id: "s1",
      categories: [changedCategory, unchangedCategory],
      unreadSources: [{ channelId: "c1", lastUnreadSeq: 1, lastAttentionSeq: null }],
      forumUnreadState: {},
    }
    capturedHookQueryData = detail
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    getActiveAccountUnreadProjection(capturedHookQueryClient).recordArrival({
      channelId: "c1",
      serverId: "s1",
      seq: 1,
    })
    const { useServer } = await import("./use-servers")

    const result = useServer("s1")

    expect(result.server).not.toBe(detail)
    expect(result.server?.categories[0]).not.toBe(changedCategory)
    expect(result.server?.categories[0]?.channels[0]?.unread).toBe(true)
    expect(result.server?.categories[1]).toBe(unchangedCategory)
    expect(result.server?.categories[1]?.channels[0]).toBe(unchangedChannel)
  })

  it("retains rolling-deploy server-detail unread rows without source vectors", async () => {
    const channel = { id: "c1", unread: true }
    const baseUnreadForum = { id: "forum-base", unread: false }
    const childUnreadForum = { id: "forum-child", unread: false }
    const detail = {
      id: "s1",
      categories: [{
        id: "cat1",
        channels: [channel, baseUnreadForum, childUnreadForum],
      }],
      forumUnreadState: {
        "forum-base": { baseUnread: true, childIds: [] },
        "forum-child": { baseUnread: false, childIds: ["child"] },
      },
    }
    capturedHookQueryData = detail
    const { useServer } = await import("./use-servers")
    const first = useServer("s1")
    expect(first.server?.categories[0]?.channels[0]?.unread).toBe(true)
    expect(first.server?.categories[0]?.channels[1]?.unread).toBe(true)
    expect(first.server?.categories[0]?.channels[2]?.unread).toBe(true)

    capturedHookQueryData = {
      ...detail,
      categories: [{
        id: "cat1",
        channels: [
          { id: "c1", unread: false },
          { id: "forum-base", unread: false },
          { id: "forum-child", unread: false },
        ],
      }],
    }
    const second = useServer("s1")
    expect(second.server?.categories[0]?.channels[0]?.unread).toBe(true)
  })

  it("composes a single server detail from canonical resources", async () => {
    const detail = { id: "srv_1", name: "Alook", description: "", icon: null, ownerId: "u_1" }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return { servers: [{ ...detail, discriminator: "0001" }] }
      if (url.endsWith("/categories")) return { categories: [{ id: "cat_1", name: "Main", private: 0 }] }
      if (url.endsWith("/channels")) return { channels: [
        { id: "ch_1", name: "general", categoryId: "cat_1" },
        { id: "ch_2", name: "loose", categoryId: null },
      ] }
      if (url.endsWith("/unreads")) return { channelIds: ["ch_1"] }
      throw new Error(`unexpected ${url}`)
    })
    const { serverQueryFn } = await import("./use-servers")
    const data = await serverQueryFn(new QueryClient(), "srv_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", expect.any(Object))
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/categories")
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/channels")
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/unreads")
    expect(data).toEqual({ ...detail, discriminator: "0001", categories: [
      { id: "cat_1", name: "Main", private: 0, channels: [{ id: "ch_1", name: "general", categoryId: "cat_1", active: false, unread: true }] },
      { id: "__uncategorized__", name: "", private: 0, channels: [{ id: "ch_2", name: "loose", categoryId: null, active: false, unread: false }] },
    ], forumUnreadState: {} })
  })

  it("resolves cold server detail without joining an in-flight rail replacement", async () => {
    let releaseRail!: (value: {
      servers: Array<{
        id: string
        name: string
        discriminator: string
        description: string
        icon: null
        ownerId: string
      }>
    }) => void
    const pendingRail = new Promise<Parameters<typeof releaseRail>[0]>((resolve) => {
      releaseRail = resolve
    })
    const identity = {
      id: "srv_1",
      name: "Alook",
      discriminator: "0001",
      description: "Build together",
      icon: null,
      ownerId: "u_1",
    }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return { servers: [identity] }
      if (url.endsWith("/categories")) return { categories: [] }
      if (url.endsWith("/channels")) return { channels: [] }
      if (url.endsWith("/unreads")) return { channelIds: [] }
      throw new Error(`unexpected ${url}`)
    })
    const { serverQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    const railReplacement = qc.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => pendingRail,
      staleTime: 0,
    })
    const detail = qc.fetchQuery({
      queryKey: communityKeys.server("srv_1"),
      queryFn: serverQueryFn(qc, "srv_1"),
      staleTime: Infinity,
    })

    try {
      await vi.waitFor(() => {
        expect(apiFetchMock.mock.calls.filter(
          ([url]) => url === "/api/community/servers",
        )).toHaveLength(1)
      })
      await expect(detail).resolves.toMatchObject(identity)
      expect(qc.getQueryState(communityKeys.servers())?.fetchStatus).toBe("fetching")
      expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers", { signal: undefined })
    } finally {
      releaseRail({ servers: [identity] })
      await Promise.allSettled([railReplacement, detail])
    }
  })

  it("reads warm server identity without issuing another list request", async () => {
    const identity = {
      id: "srv_1",
      name: "Alook",
      discriminator: "0001",
      description: "Build together",
      icon: null,
      ownerId: "u_1",
    }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/categories")) return { categories: [] }
      if (url.endsWith("/channels")) return { channels: [] }
      if (url.endsWith("/unreads")) return { channelIds: [] }
      throw new Error(`unexpected ${url}`)
    })
    const { serverQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.servers(), { servers: [identity] })

    await expect(serverQueryFn(qc, "srv_1")()).resolves.toMatchObject(identity)

    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
  })

  it("cold-boots a forum fallback from a canonical unread child outside the sidebar projection", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return { servers: [{
        id: "srv_1", name: "Alook", discriminator: "0001", icon: null, ownerId: "u_1",
      }] }
      if (url.endsWith("/categories")) return { categories: [{ id: "cat_1", name: "Main", private: 0 }] }
      if (url.endsWith("/channels")) return { channels: [{
        id: "forum_1", name: "Forum", type: "forum", categoryId: "cat_1",
      }] }
      if (url.endsWith("/unreads")) return {
        channelIds: ["post_hidden"],
        childChannels: [{ id: "post_hidden", parentChannelId: "forum_1" }],
      }
      throw new Error(`unexpected ${url}`)
    })

    const { serverQueryFn } = await import("./use-servers")
    const data = await serverQueryFn(new QueryClient(), "srv_1")()

    expect(data.categories[0]?.channels[0]?.unread).toBe(true)
    expect(data.forumUnreadState).toEqual({
      forum_1: { baseUnread: false, childIds: ["post_hidden"] },
    })
  })

  it("nests the server(id) key under servers() so prefix invalidation cascades", async () => {
    const detail = { id: "srv_1", name: "Alook", description: "", icon: null, ownerId: "u_1", categories: [] }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return { servers: [{ ...detail, discriminator: "0001" }] }
      if (url.endsWith("/categories")) return { categories: [] }
      if (url.endsWith("/channels")) return { channels: [] }
      if (url.endsWith("/unreads")) return { channelIds: [] }
      throw new Error(`unexpected ${url}`)
    })
    const { serverQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    const key = communityKeys.server("srv_1")
    await qc.fetchQuery({ queryKey: key, queryFn: serverQueryFn(qc, "srv_1") })
    expect(qc.getQueryData(key)).toBeDefined()
    // Invalidating the servers() prefix invalidates the detail entry too.
    await qc.invalidateQueries({ queryKey: communityKeys.servers() })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)

    apiFetchMock.mockClear()
    await qc.fetchQuery({
      queryKey: key,
      queryFn: serverQueryFn(qc, "srv_1"),
      staleTime: Infinity,
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(4)
  })

  it("rejects a stale raw unread read instead of caching false read badges", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return { servers: [{ id: "srv_1", name: "Alook", discriminator: "0001", icon: null, ownerId: "u_1" }] }
      if (url.endsWith("/categories")) return { categories: [] }
      if (url.endsWith("/channels")) return { channels: [{ id: "ch_1", name: "general", categoryId: null }] }
      if (url.endsWith("/unreads")) return { channelIds: [], stale: true }
      throw new Error(`unexpected ${url}`)
    })

    const { serverQueryFn } = await import("./use-servers")
    await expect(serverQueryFn(new QueryClient(), "srv_1")()).rejects.toThrow("stale D1 read")
  })
})
