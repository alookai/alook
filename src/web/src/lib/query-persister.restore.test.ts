import { describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore, type PersistedClient } from "@tanstack/react-query-persist-client"
import { communityKeys } from "./query-keys"
import { createCommunityRestorePersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS } from "./query-persister"

function snapshot(): PersistedClient {
  const client = new QueryClient()
  client.setQueryData(communityKeys.communityDbCollection("viewer", "profiles"), [{ id: "peer", identityComplete: false, name: "Disk" }], { updatedAt: 0 })
  client.setQueryData(communityKeys.communityDbCollection("viewer", "messages"), [])
  client.setQueryData(communityKeys.communityDbCollection("other", "profiles"), [{ id: "private", identityComplete: false, name: "Other" }])
  client.setQueryData(communityKeys.communityDbCollection("viewer", "folders"), [{ invalid: true }])
  client.setQueryData(["resource-window"], { ids: ["id"] })
  const value = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) }
  client.clear()
  return value
}

describe("community native restore input", () => {
  it("splits validated canonical input before native hydration and consumes it once", async () => {
    const disk = snapshot()
    const original = { restoreClient: vi.fn(async () => disk), persistClient: vi.fn(async () => {}), removeClient: vi.fn(async () => {}) }
    const restore = createCommunityRestorePersister(original, "viewer")
    const client = new QueryClient()
    const profileKey = communityKeys.communityDbCollection("viewer", "profiles")
    client.setQueryData(profileKey, [{ id: "peer", identityComplete: false, name: "RSC" }])
    await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
    expect(client.getQueryData(profileKey)).toEqual([{ id: "peer", identityComplete: false, name: "RSC" }])
    expect(client.getQueryData(["resource-window"])).toEqual({ ids: ["id"] })
    const input = restore.takeCollections()
    expect(Object.keys(input).sort()).toEqual(["messages", "profiles"])
    expect(input.profiles).toEqual({ rows: [{ id: "peer", identityComplete: false, name: "Disk" }], updatedAt: 0 })
    expect(input.messages?.rows).toEqual([])
    expect(restore.takeCollections()).toEqual({})
    await restore.persister.persistClient(disk)
    expect(original.persistClient).toHaveBeenCalledWith(disk)
    client.clear()
  })

  it.each(["buster", "expired", "missing-timestamp"])("discards canonical input when native restore rejects %s", async (reason) => {
    const disk = snapshot()
    if (reason === "buster") disk.buster = "old"
    if (reason === "expired") disk.timestamp = Date.now() - PERSIST_MAX_AGE_MS - 1
    if (reason === "missing-timestamp") disk.timestamp = 0
    const original = { restoreClient: async () => disk, persistClient: async () => {}, removeClient: vi.fn(async () => {}) }
    const restore = createCommunityRestorePersister(original, "viewer")
    const client = new QueryClient()
    await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
    expect(original.removeClient).toHaveBeenCalledOnce()
    expect(restore.takeCollections()).toEqual({})
    expect(client.getQueryCache().getAll()).toEqual([])
    client.clear()
  })

  it("does not invent disk input for an empty restore or an anonymous viewer", async () => {
    const original = { restoreClient: vi.fn<() => Promise<PersistedClient | undefined>>().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(undefined), persistClient: async () => {}, removeClient: async () => {} }
    const restore = createCommunityRestorePersister(original, "viewer")
    await restore.persister.restoreClient()
    await restore.persister.restoreClient()
    expect(restore.takeCollections()).toEqual({})
    const anonymous = createCommunityRestorePersister({ ...original, restoreClient: async () => snapshot() }, null)
    await anonymous.persister.restoreClient()
    expect(anonymous.takeCollections()).toEqual({})
  })
})
