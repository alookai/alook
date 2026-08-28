import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

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
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedHookQueryClient,
    useQuery: (config: CapturedQueryConfig) => {
      capturedQueryConfig = config
      return { data: undefined }
    },
  }
})

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedQueryConfig = null
  capturedHookQueryClient = new QueryClient()
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

  it("joins the canonical servers request on cold concurrency and reuses warm caches", async () => {
    let releaseServers!: (value: {
      servers: Array<{
        id: string
        name: string
        discriminator: string
        description: string
        icon: null
        ownerId: string
      }>
    }) => void
    const pendingServers = new Promise<Parameters<typeof releaseServers>[0]>((resolve) => {
      releaseServers = resolve
    })
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/servers") return pendingServers
      if (url.endsWith("/categories")) return { categories: [] }
      if (url.endsWith("/channels")) return { channels: [] }
      if (url.endsWith("/unreads")) return { channelIds: [] }
      throw new Error(`unexpected ${url}`)
    })
    const { serverQueryFn, serversQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    const list = qc.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: serversQueryFn,
      staleTime: Infinity,
    })
    const detail = qc.fetchQuery({
      queryKey: communityKeys.server("srv_1"),
      queryFn: serverQueryFn(qc, "srv_1"),
      staleTime: Infinity,
    })

    await vi.waitFor(() => {
      expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/servers")).toHaveLength(1)
    })
    releaseServers({
      servers: [{
        id: "srv_1",
        name: "Alook",
        discriminator: "0001",
        description: "Build together",
        icon: null,
        ownerId: "u_1",
      }],
    })
    await Promise.all([list, detail])
    expect(apiFetchMock).toHaveBeenCalledTimes(4)
    for (const resource of ["categories", "channels", "unreads"]) {
      expect(apiFetchMock.mock.calls.filter(
        ([url]) => url === `/api/community/servers/srv_1/${resource}`,
      )).toHaveLength(1)
    }

    apiFetchMock.mockClear()
    await Promise.all([
      qc.fetchQuery({
        queryKey: communityKeys.servers(),
        queryFn: serversQueryFn,
        staleTime: Infinity,
      }),
      qc.fetchQuery({
        queryKey: communityKeys.server("srv_1"),
        queryFn: serverQueryFn(qc, "srv_1"),
        staleTime: Infinity,
      }),
    ])
    expect(apiFetchMock).not.toHaveBeenCalled()
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
