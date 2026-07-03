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
        { id: "srv_1", name: "Alook", icon: null, role: "owner", unread: true, mentions: 3 },
        { id: "srv_2", name: "Beta", icon: null, role: "member" },
      ],
    })
    const { serversQueryFn } = await import("./use-servers")
    const data = await serversQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers")
    expect(data.servers[0].initial).toBe("A")
    expect(data.servers[0].isOwner).toBe(true)
    expect(data.servers[0].unread).toBe(true)
    expect(data.servers[0].mentions).toBe(3)
    expect(data.servers[0].active).toBe(false)
    expect(data.servers[1].mentions).toBe(0)
    expect(data.servers[1].unread).toBe(false)
    expect(data.servers[1].isOwner).toBe(false)
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
  it("returns a single server detail from GET /api/community/servers/:id", async () => {
    const detail = { id: "srv_1", name: "Alook", description: "", icon: null, ownerId: "u_1", categories: [] }
    apiFetchMock.mockResolvedValueOnce(detail)
    const { serverQueryFn } = await import("./use-servers")
    const data = await serverQueryFn("srv_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1")
    expect(data).toEqual(detail)
  })

  it("nests the server(id) key under servers() so prefix invalidation cascades", async () => {
    const detail = { id: "srv_1", name: "Alook", description: "", icon: null, ownerId: "u_1", categories: [] }
    apiFetchMock.mockResolvedValueOnce(detail)
    const { serverQueryFn } = await import("./use-servers")
    const qc = new QueryClient()
    const key = communityKeys.server("srv_1")
    await qc.fetchQuery({ queryKey: key, queryFn: serverQueryFn("srv_1") })
    expect(qc.getQueryData(key)).toBeDefined()
    // Invalidating the servers() prefix invalidates the detail entry too.
    await qc.invalidateQueries({ queryKey: communityKeys.servers() })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })
})
