import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useServers / serversQueryFn", () => {
  it("materialises raw server rows into render-ready Server shape", async () => {
    apiFetchMock.mockResolvedValueOnce({
      servers: [
        { id: "srv_1", name: "Alook", discriminator: "0042", icon: null, role: "owner", mentions: 3 },
        { id: "srv_2", name: "Beta", discriminator: "12345", icon: null, role: "member" },
      ],
    })
    const { serversQueryFn } = await import("./use-servers")
    const data = await serversQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers")
    expect(data.servers[0].initial).toBe("A")
    expect(data.servers[0].isOwner).toBe(true)
    expect(data.servers[0].mentions).toBe(3)
    expect(data.servers[0].active).toBe(false)
    expect(data.servers[0].discriminator).toBe("0042")
    // `unread` has been removed from the Server type — the mapper must not
    // project it. Pin the invariant so a future revival gets caught.
    expect((data.servers[0] as { unread?: boolean }).unread).toBeUndefined()
    expect(data.servers[1].mentions).toBe(0)
    expect(data.servers[1].isOwner).toBe(false)
    expect((data.servers[1] as { unread?: boolean }).unread).toBeUndefined()
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
    const data = await serverQueryFn("srv_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers")
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/categories")
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/channels")
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/unreads")
    expect(data).toEqual({ ...detail, categories: [
      { id: "cat_1", name: "Main", private: 0, channels: [{ id: "ch_1", name: "general", categoryId: "cat_1", active: false, unread: true }] },
      { id: "__uncategorized__", name: "", private: 0, channels: [{ id: "ch_2", name: "loose", categoryId: null, active: false, unread: false }] },
    ] })
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
    await qc.fetchQuery({ queryKey: key, queryFn: serverQueryFn("srv_1") })
    expect(qc.getQueryData(key)).toBeDefined()
    // Invalidating the servers() prefix invalidates the detail entry too.
    await qc.invalidateQueries({ queryKey: communityKeys.servers() })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
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
    await expect(serverQueryFn("srv_1")()).rejects.toThrow("stale D1 read")
  })
})
