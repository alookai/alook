import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore, type PersistedClient } from "@tanstack/react-query-persist-client"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { restoreCommunityCollections } from "./community-db/sync"
import { communityKeys } from "./query-keys"
import { communityUserProfilePatch, writeCommunityProfilePatches } from "./community/profile-seed"
import { readCommunityProfile } from "./community/profile-read"
import { createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS } from "./query-persister"

const clients: QueryClient[] = []
const registries: CommunityDbRegistry[] = []
const profile = (id: string) => ({ id, name: id, discriminator: "0042", avatar: null, avatarVersion: 3,
  aboutMe: "Biography", bannerColor: null, kind: "bot" as const, ownerUserId: "owner", ownerHandle: "Owner#0042",
  mutualServers: 2, ownedByViewer: false, statusEmoji: "🌿", statusText: "Working" })
const client = () => { const value = new QueryClient(); clients.push(value); return value }
const snapshot = (value: QueryClient, timestamp = Date.now()): PersistedClient => ({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(value) })

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.cleanup()
  for (const value of clients.splice(0)) value.clear()
})

describe("durable user facts", () => {
  it("retains complete user fields for relationship-only people and a previously opened card", async () => {
    const user = "user-profile-relations", value = client()
    const profiles = ["accepted", "incoming", "outgoing", "blocked", "opened-card"].map(profile)
    value.setQueryData(communityKeys.communityDbCollection(user, "profiles"), profiles)
    value.setQueryData(communityKeys.communityDbCollection(user, "friendships"), profiles.slice(0, 4).map(row => ({ id: `relation:${row.id}`, userId: row.id, kind: row.id })))
    const persister = createIdbPersister(user)
    await persister.persistClient(snapshot(value))
    const restored = createCommunityRestorePersister(persister, user)
    await restored.persister.restoreClient()
    expect(restored.takeCollections().profiles?.rows).toEqual(profiles)
  })

  it("keeps user facts past one day without extending other business collections or windows", async () => {
    const user = "user-profile-expiry", value = client()
    const row = { ...profile("peer"), presence: "online" }
    const updatedAt = Date.now() - PERSIST_MAX_AGE_MS - 1000
    value.setQueryData(communityKeys.communityDbCollection(user, "profiles"), [row], { updatedAt })
    value.setQueryData(communityKeys.communityDbCollection(user, "friendships"), [{ id: "friend", userId: "peer", kind: "accepted" }], { updatedAt })
    value.setQueryData(communityKeys.communityDbCollection(user, "folders"), [{ id: "folder", name: "Old" }], { updatedAt })
    const persister = createIdbPersister(user)
    await persister.persistClient(snapshot(value, updatedAt))
    const restore = createCommunityRestorePersister(createIdbPersister(user), user)
    await persistQueryClientRestore({ queryClient: client(), persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
    const input = restore.takeCollections()
    expect(input.profiles).toEqual({ rows: [row], updatedAt })
    expect(input.friendships).toBeUndefined()
    expect(input.folders).toBeUndefined()
  })

  it("persists a live presence update and reveals it after a new account runtime restores", async () => {
    const user = "user-profile-presence", first = createCommunityDbRegistry(client(), user)
    registries.push(first)
    await first.preload()
    writeCommunityProfilePatches([communityUserProfilePatch("peer", profile("peer"))], first)
    first.runtime.ws.actions.setPresence("peer", "online")
    const persister = createIdbPersister(user)
    await persister.persistClient(snapshot(first.queryClient))
    const restore = createCommunityRestorePersister(createIdbPersister(user), user)
    await restore.persister.restoreClient()
    const second = createCommunityDbRegistry(client(), user)
    registries.push(second)
    await restoreCommunityCollections(second, restore.takeCollections())
    await second.preload()
    expect(second.runtime.ws.get().presenceByUserId.has("peer")).toBe(false)
    expect(readCommunityProfile(second.collections.profiles.get("peer"), "peer").presence).toBe("online")
    expect(second.collections.profiles.get("peer")).toMatchObject(profile("peer"))
  })

  it("keeps an observed presence that arrives before the user's complete identity", async () => {
    const registry = createCommunityDbRegistry(client(), "user-profile-order")
    registries.push(registry)
    await registry.preload()
    registry.runtime.ws.actions.setPresence("peer", "offline")
    writeCommunityProfilePatches([communityUserProfilePatch("peer", profile("peer"))], registry)
    expect(registry.collections.profiles.get("peer")).toHaveProperty("presence", "offline")
  })

  it("does not persist an unobserved offline value just to render a user", async () => {
    const registry = createCommunityDbRegistry(client(), "user-profile-unobserved")
    registries.push(registry)
    await registry.preload()
    writeCommunityProfilePatches([communityUserProfilePatch("peer", profile("peer"))], registry)
    expect(registry.collections.profiles.get("peer")).not.toHaveProperty("presence")
  })
})
