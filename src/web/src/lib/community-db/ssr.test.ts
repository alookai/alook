import React from "react"
import { renderToString } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { eq } from "@tanstack/react-db"
import { describe, expect, it, vi } from "vitest"
import { createCommunityDbRegistry } from "./collections"
import { CommunityDbProvider, useCanonicalCommunityProfile } from "./projections"
import { communityCollectionQuery } from "./queries"
import { dehydrateCommunityProjections, preloadCommunityProjection } from "./live-query"
import { communityKeys } from "@/lib/query-keys"

function View() {
  const profile = useCanonicalCommunityProfile("viewer")
  return React.createElement("span", null, profile?.name ?? "pending")
}

describe("native DB server snapshot handoff", () => {
  it("renders the matching live-query snapshot while the client restore adapter is still pending", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const serverClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    const key = communityKeys.communityDbCollection("viewer", "profiles")
    const rows = [{ id: "viewer", name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 1, identityComplete: true }]
    serverClient.setQueryData(key, rows)
    const server = createCommunityDbRegistry(serverClient, "viewer")
    await server.collections.profiles.preload()
    const binding = await preloadCommunityProjection(server, communityCollectionQuery(server, "profiles", ({ row }) => eq(row.id, "viewer")))
    const state = JSON.parse(JSON.stringify(dehydrateCommunityProjections(server, [binding])))
    expect(state.liveQueries[0].snapshot.rows).toHaveLength(1)
    await server.cleanup()
    serverClient.clear()
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    client.setQueryData(key, rows)
    const owner = createCommunityDbRegistry(client, "viewer", { waitForRestore: ready })
    owner.dbClient.hydrate(state)
    try {
      const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(CommunityDbProvider, { registry: owner }, React.createElement(View))))
      expect(html).toBe("<span>Viewer</span>")
    } finally {
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      await owner.cleanup()
      client.clear()
      const captured = errors.mock.calls
      errors.mockRestore()
      expect(captured).toEqual([])
    }
  })
})
