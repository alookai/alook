import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { profileSchema } from "./schema"
import { writeCommunityCollectionRows } from "./write"

const owners: CommunityDbRegistry[] = []

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.cleanup()))
  vi.useRealTimers()
})

function owner() {
  const registry = createCommunityDbRegistry(new QueryClient(), "viewer")
  owners.push(registry)
  return registry
}

describe("canonical collection publication", () => {
  it("reproduces snapshot loss with the library default collection GC", async () => {
    vi.useFakeTimers()
    const queryClient = new QueryClient()
    const queryKey = ["default-gc-control"]
    const collection = createCollection(queryCollectionOptions({
      id: "default-gc-control",
      queryClient,
      queryKey,
      queryFn: () => queryClient.getQueryData<Array<{ id: string }>>(queryKey) ?? [],
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: 24 * 60 * 60 * 1000,
    }))
    try {
      await collection.preload()
      collection.utils.writeUpsert({ id: "alice" })
      expect(collection.get("alice")).toMatchObject({ id: "alice" })
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(queryClient.getQueryData(queryKey)).toBeUndefined()
      await collection.preload()
      expect(collection.get("alice")).toBeUndefined()
    } finally {
      await collection.cleanup()
      queryClient.clear()
    }
  })

  it("retains account facts beyond the former idle GC window and releases them on owner cleanup", async () => {
    vi.useFakeTimers()
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice" } }], registry)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(registry.collections.profiles.status).toBe("ready")
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alice")
    await registry.collections.profiles.preload()
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alice")
    await registry.cleanup()
    expect(registry.collections.profiles.size).toBe(0)
    expect(registry.queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "profiles"),
    )).toBeUndefined()
  })

  it("publishes one changed profile once and leaves unrelated rows untouched", async () => {
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([
      { id: "alice", identityAbout: { name: "Alice" } },
      { id: "bob", identityAbout: { name: "Bob" } },
    ], registry)
    const bob = registry.collections.profiles.get("bob")
    const upsert = vi.spyOn(registry.collections.profiles.utils, "writeUpsert")
    const publish = vi.spyOn(registry.queryClient, "setQueryData")

    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alicia" } }], registry)

    expect(upsert).toHaveBeenCalledOnce()
    expect(upsert.mock.calls[0]?.[0]).toMatchObject([{ userId: "alice", name: "Alicia" }])
    expect(publish).toHaveBeenCalledOnce()
    expect(registry.collections.profiles.get("bob")).toBe(bob)
    expect(registry.queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "profiles"),
    )).toMatchObject([{ userId: "alice", name: "Alicia" }, { userId: "bob", name: "Bob" }])
  })

  it("keeps equal rows silent and synchronizes deleting the final row", async () => {
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice" } }], registry)
    const current = Array.from(registry.collections.profiles.values())
    const publish = vi.spyOn(registry.queryClient, "setQueryData")

    writeCommunityCollectionRows(registry, "profiles", current.map((row) => ({ ...row })), (row) => row.userId)
    expect(publish).not.toHaveBeenCalled()

    writeCommunityCollectionRows(registry, "profiles", [], (row) => row.userId)
    expect(publish).toHaveBeenCalledOnce()
    expect(registry.collections.profiles.size).toBe(0)
    expect(registry.queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "profiles"),
    )).toEqual([])
  })

  it("commits a confirmed value equal to the visible optimistic overlay before the native transaction drops it", async () => {
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice" } }], registry)
    const transaction = registry.dbClient.createTransaction({ mutationFn: async () => {
      writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alicia" } }], registry)
    } })
    transaction.mutate(() => registry.collections.profiles.update("alice", (row) => { row.name = "Alicia" }))
    await transaction.isPersisted.promise
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alicia")
    expect(registry.queryClient.getQueryData(communityKeys.communityDbCollection("viewer", "profiles"))).toMatchObject([{ userId: "alice", name: "Alicia" }])
  })

  it("seeds a not-ready collection through the restore snapshot and then synchronizes", async () => {
    const registry = owner()
    const row = profileSchema.parse({
      userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 1,
    })
    expect(registry.collections.profiles.status).not.toBe("ready")
    writeCommunityCollectionRows(registry, "profiles", [row], (profile) => profile.userId)
    expect(registry.queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "profiles"),
    )).toEqual([row])

    await registry.preload()
    expect(registry.collections.profiles.get("alice")).toMatchObject(row)
    writeCommunityCollectionRows(registry, "profiles", [{ ...row, name: "Alicia" }], (profile) => profile.userId)
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alicia")
  })
})
