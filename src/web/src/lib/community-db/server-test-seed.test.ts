import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { seedCommunityServers } from "./server-test-seed"

let registry: CommunityDbRegistry | null = null

afterEach(async () => {
  await registry?.cleanup()
  registry = null
})

describe("seedCommunityServers", () => {
  it("merges id-keyed server rows and preserves current viewer memberships", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await Promise.all([
      registry.ensureCollectionReady("servers"),
      registry.ensureCollectionReady("serverMemberships"),
    ])

    seedCommunityServers(registry, { servers: [{
      id: "one",
      name: "One",
      discriminator: "0001",
      initial: "O",
      active: false,
      unread: false,
      mentions: 0,
      isOwner: true,
      icon: null,
    }] })
    await vi.waitFor(() => expect(registry?.collections.servers.get("one")?.name).toBe("One"))

    seedCommunityServers(registry, { servers: [{
      id: "two",
      name: "Two",
      discriminator: "0002",
      initial: "T",
      active: false,
      unread: true,
      mentions: 2,
      isOwner: false,
      icon: null,
    }] }, "merge")
    await vi.waitFor(() => expect([...registry!.collections.servers.keys()].sort())
      .toEqual(["one", "two"]))

    expect([...registry.collections.serverMemberships.values()]
      .filter((row) => row.viewer)
      .map((row) => [row.serverId, row.role])
      .sort()).toEqual([["one", "owner"], ["two", "member"]])
  })
})
