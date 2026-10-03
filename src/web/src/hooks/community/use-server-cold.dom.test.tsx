import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { useServer, useServers } from "./use-servers"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
afterEach(() => api.mockReset())
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }) }
const list = { servers: [{ id: "srv", name: "Cold", discriminator: "0001", icon: null, ownerId: "viewer", role: "owner" }] }
function respond(path: string) {
  if (path.endsWith("/categories")) return { categories: [] }
  if (path.endsWith("/channels")) return { channels: [] }
  return list
}
describe("actual cold server native read", () => {
  it("loads identity without a rail observer and publishes canonical DB", async () => {
    api.mockImplementation(async (path: string) => respond(path))
    const qc = client()
    const view = renderHook(() => useServer("srv"), { wrapper: ({ children }) => <CommunityTestProvider client={qc}>{children}</CommunityTestProvider> })
    await waitFor(() => expect(view.result.current.server?.name).toBe("Cold"))
    expect(getCommunityDbRegistry(qc)?.collections.servers.get("srv")?.name).toBe("Cold")
    expect(api.mock.calls.filter(([path]) => path === "/api/community/servers")).toHaveLength(1)
  })
  it("deduplicates the cold identity read with a real rail observer", async () => {
    let resolve!: (value: typeof list) => void
    api.mockImplementation((path: string) => path === "/api/community/servers" ? new Promise((done) => { resolve = done }) : Promise.resolve(respond(path)))
    const qc = client()
    const wrapper = ({ children }: { children: React.ReactNode }) => <CommunityTestProvider client={qc}>{children}</CommunityTestProvider>
    const view = renderHook(() => { const server = useServer("srv"); const rail = useServers(); return { server, rail } }, { wrapper })
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/api/community/servers")).toHaveLength(1))
    resolve(list)
    await waitFor(() => { expect(view.result.current.server.server?.name).toBe("Cold"); expect(view.result.current.rail.servers[0]?.name).toBe("Cold") })
  })
})
