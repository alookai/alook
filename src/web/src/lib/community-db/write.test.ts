import { messageResourceFixture } from "@/test/community-resource-fixtures"
import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { profileSchema } from "./schema"
import { writeCommunityCollectionRows } from "./write"
import { ingestMessages, projectCommunityWsEventToDb } from "./sync"

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

function observeProfilePublications(registry: CommunityDbRegistry) {
  const cache = registry.queryClient.getQueryCache()
  const query = cache.find({
    queryKey: communityKeys.communityDbCollection(registry.scopeId, "profiles"),
    exact: true,
  })
  expect(query).toBeDefined()
  const publish = vi.fn()
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === "updated" && event.query === query) publish(event.query.state.data)
  })
  return { publish, unsubscribe }
}

describe("canonical collection publication", () => {
  it("replaces optional business fields and avoids republishing repeated equivalent snapshots", async () => {
    const registry = owner()
    await registry.preload()
    const profile = profileSchema.parse({ id: "complete", name: "Complete", discriminator: null, avatar: null, avatarVersion: 0 })
    await writeCommunityCollectionRows(registry, "profiles", [{ ...profile, aboutMe: "Private previous content" }], item => item.id)
    const { publish, unsubscribe } = observeProfilePublications(registry)
    try {
      await writeCommunityCollectionRows(registry, "profiles", [profile], item => item.id)
      expect(registry.collections.profiles.get(profile.id)?.aboutMe).toBeUndefined()
      expect(publish).toHaveBeenCalledOnce()
      await writeCommunityCollectionRows(registry, "profiles", [profile], item => item.id)
      await writeCommunityCollectionRows(registry, "profiles", [{ ...profile, aboutMe: undefined }], item => item.id)
      expect(publish).toHaveBeenCalledOnce()
    } finally { unsubscribe() }
  })

  it("removes only documented live row metadata and still rejects missing or unknown business fields", async () => {
    const registry = owner()
    await registry.preload()
    const profile = profileSchema.parse({ id: "complete", name: "Complete", discriminator: null, avatar: null, avatarVersion: 0 })
    await writeCommunityCollectionRows(registry, "profiles", [profile], item => item.id)
    const live = registry.collections.profiles.get(profile.id)!
    expect(live).toHaveProperty("$key", profile.id)
    await writeCommunityCollectionRows(registry, "profiles", [{ ...live, name: "Updated" }], item => item.id)
    const key = communityKeys.communityDbCollection(registry.scopeId, "profiles")
    const before = registry.queryClient.getQueryData(key)
    await expect(async () => writeCommunityCollectionRows(registry, "profiles", [{ ...live, $unknown: true }], item => item.id)).rejects.toThrow()
    await expect(async () => writeCommunityCollectionRows(registry, "profiles", [{ ...live, avatar: undefined }], item => item.id)).rejects.toThrow()
    expect(registry.queryClient.getQueryData(key)).toBe(before)
    expect(registry.collections.profiles.get(profile.id)?.name).toBe("Updated")
  })

  it.each([false, true])("rejects incomplete rows before canonical publication with ready=%s", async ready => {
    const registry = owner()
    if (ready) await registry.preload()
    const row = profileSchema.parse({ id: "complete", name: "Complete", discriminator: null, avatar: null, avatarVersion: 0 })
    await writeCommunityCollectionRows(registry, "profiles", [row], item => item.id)
    const key = communityKeys.communityDbCollection(registry.scopeId, "profiles")
    const before = registry.queryClient.getQueryData(key)
    await expect(async () => writeCommunityCollectionRows(registry, "profiles", [{ ...row, avatar: undefined }], item => item.id)).rejects.toThrow()
    expect(registry.queryClient.getQueryData(key)).toBe(before)
    expect(registry.collections.profiles.get("partial")).toBeUndefined()
  })

  it.each([false, true])("requires full WS messages before ready=%s and honors explicit empty", async (ready) => {
    const registry = owner()
    if (ready) await registry.preload()
    const attachments = [{ id: "notes", name: "notes.txt", url: "/notes.txt", thumbnailUrl: null, contentType: "text/plain", sizeBytes: 1024, width: null, height: null }]
    const embeds = [{ title: "Reference" }]
    const message = messageResourceFixture({ id: "m-rich", channelId: "channel", seq: 3, authorId: "peer", authorName: "Peer",
      authorAvatar: "peer-avatar", authorAvatarVersion: 0, content: "before", createdAt: "2026-08-07T10:00:00.000Z", attachments, embeds })
    ingestMessages(registry, "channel", [message])
    const key = communityKeys.communityDbCollection(registry.scopeId, "messages")
    const before = registry.queryClient.getQueryData(key)
    expect(() => ingestMessages(registry, "channel", [{ id: message.id, content: "summary" }])).toThrow()
    expect(registry.queryClient.getQueryData(key)).toBe(before)
    expect(registry.collections.messages.status === "ready").toBe(ready)
    projectCommunityWsEventToDb(registry.queryClient, { type: "community:message.create",
      serverId: "server", channelId: "channel", message: { ...message, content: "after" } })
    expect(registry.queryClient.getQueryData(key)).toMatchObject([{ ...message, content: "after" }])
    await registry.preload()
    expect(registry.collections.messages.get(message.id)).toMatchObject({ content: "after", attachments, embeds })
    projectCommunityWsEventToDb(registry.queryClient, { type: "community:message.create",
      serverId: "server", channelId: "channel", message: { ...message, attachments: [], embeds: [] } })
    expect(registry.collections.messages.get(message.id)).toMatchObject({ attachments: [], embeds: [] })
  })

  it.each([false, true])("does not create an absent profile from a sparse patch with ready=%s", async ready => {
    const registry = owner()
    if (ready) await registry.preload()
    writeCommunityProfilePatches([{ id: "unknown", identityAbout: { name: "Unknown" } }], registry)
    const key = communityKeys.communityDbCollection(registry.scopeId, "profiles")
    expect(registry.queryClient.getQueryData<Array<{ id: string }>>(key)?.some(row => row.id === "unknown") ?? false).toBe(false)
    writeCommunityProfilePatches([{ id: "known", identityAbout: { name: "Known", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } }], registry)
    writeCommunityProfilePatches([{ id: "known", identityAbout: { name: "Renamed" } }], registry)
    expect(registry.queryClient.getQueryData(key)).toMatchObject([{ id: "known", name: "Renamed", discriminator: null, avatar: null, avatarVersion: 0 }])
  })

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
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } }], registry)
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
      { id: "alice", identityAbout: { name: "Alice", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } },
      { id: "bob", identityAbout: { name: "Bob", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } },
    ], registry)
    const bob = registry.collections.profiles.get("bob")
    const upsert = vi.spyOn(registry.collections.profiles.utils, "writeUpsert")
    const { publish, unsubscribe } = observeProfilePublications(registry)
    try {
      writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alicia" } }], registry)

      expect(upsert).toHaveBeenCalledOnce()
      expect(upsert.mock.calls[0]?.[0]).toMatchObject([{ id: "alice", name: "Alicia" }])
      expect(publish).toHaveBeenCalledOnce()
      expect(publish.mock.calls[0]?.[0]).toMatchObject([{ id: "alice", name: "Alicia" }, { id: "bob", name: "Bob" }])
      expect(registry.collections.profiles.get("bob")).toBe(bob)
      expect(registry.queryClient.getQueryData(
        communityKeys.communityDbCollection("viewer", "profiles"),
      )).toMatchObject([{ id: "alice", name: "Alicia" }, { id: "bob", name: "Bob" }])
    } finally {
      unsubscribe()
    }
  })

  it("keeps equal rows silent and synchronizes deleting the final row", async () => {
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } }], registry)
    const current = Array.from(registry.collections.profiles.values())
    const key = communityKeys.communityDbCollection("viewer", "profiles")
    const previous = registry.queryClient.getQueryData(key)
    const { publish, unsubscribe } = observeProfilePublications(registry)
    try {
      await writeCommunityCollectionRows(registry, "profiles", current.map((row) => ({ ...row })), (row) => row.id)
      expect(publish).not.toHaveBeenCalled()
      expect(registry.queryClient.getQueryData(key)).toBe(previous)

      await writeCommunityCollectionRows(registry, "profiles", [], (row) => row.id)
      expect(publish).toHaveBeenCalledExactlyOnceWith([])
      expect(registry.collections.profiles.size).toBe(0)
      expect(registry.queryClient.getQueryData(key)).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("commits a confirmed value equal to the visible optimistic overlay before the native transaction drops it", async () => {
    const registry = owner()
    await registry.preload()
    writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alice", discriminator: null }, avatar: { avatar: null, avatarVersion: 0 } }], registry)
    const transaction = registry.dbClient.createTransaction({ mutationFn: async () => {
      writeCommunityProfilePatches([{ id: "alice", identityAbout: { name: "Alicia" } }], registry)
    } })
    transaction.mutate(() => registry.collections.profiles.update("alice", (row) => { row.name = "Alicia" }))
    await transaction.when("settled")
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alicia")
    expect(registry.queryClient.getQueryData(communityKeys.communityDbCollection("viewer", "profiles"))).toMatchObject([{ id: "alice", name: "Alicia" }])
  })

  it("seeds a not-ready collection through the restore snapshot and then synchronizes", async () => {
    const registry = owner()
    const row = profileSchema.parse({
      id: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 1,
    })
    expect(registry.collections.profiles.status).not.toBe("ready")
    writeCommunityCollectionRows(registry, "profiles", [row], (profile) => profile.id)
    expect(registry.queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "profiles"),
    )).toEqual([row])

    await registry.preload()
    expect(registry.collections.profiles.get("alice")).toMatchObject(row)
    writeCommunityCollectionRows(registry, "profiles", [{ ...row, name: "Alicia" }], (profile) => profile.id)
    expect(registry.collections.profiles.get("alice")?.name).toBe("Alicia")
  })
})
