import "fake-indexeddb/auto"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { createIdbPersister, PERSIST_BUSTER, shouldPersistQuery } from "@/lib/query-persister"
import { persistentCommunityListResource } from "./list-persistence"

const machine = { id: "machine", hostname: "host", displayName: "Computer", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "1", createdAt: "created", updatedAt: "updated", status: "online", lastSeenAt: "now", availableRuntimes: [{ id: "codex", status: "healthy" }], lastRuntimeError: { requested: "bad", available: [], at: "now" }, quota: [{ limits: "private observation" }] }
const bot = { id: "bot", machineId: "machine", runtime: "codex", modelName: "model", reasoningEffort: null, runtimeConfigRevision: 4, isActive: true, dailyActivity: [{ day: "today" }], lastRefreshContextAt: "now", usage: { capability: "supported" }, name: "Duplicate name", image: "duplicate-avatar", presence: "online" }

describe("native list resource persistence", () => {
  it("keeps stable metadata while removing machine observations and account allowance", () => {
    const live = { machines: [machine], machineCapacity: { ownedCount: 1, limit: 20 } }
    const stable = persistentCommunityListResource(communityKeys.machines(), live)!
    expect(stable).toEqual({ machines: [{ id: "machine", hostname: "host", displayName: "Computer", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "1", createdAt: "created", updatedAt: "updated" }], complete: true, observed: false, source: "restored_idb" })
    expect(live.machines[0].status).toBe("online")
    expect(live.machineCapacity.limit).toBe(20)
    expect(shouldPersistQuery(communityKeys.machines(), { machines: [machine], complete: false })).toBe(false)
    expect(shouldPersistQuery(communityKeys.machines(), { machines: [{ id: "incomplete" }] })).toBe(false)
  })

  it("keeps the bots resource IDs and config while profiles remain canonical and observations become unknown", () => {
    const stable = persistentCommunityListResource(communityKeys.bots(), { bots: [bot], limit: 20, activeCount: 1 })
    expect(stable).toEqual({ bots: [{ id: "bot", machineId: "machine", runtime: "codex", modelName: "model", reasoningEffort: null, runtimeConfigRevision: 4 }], observed: false, source: "restored_idb" })
    expect(persistentCommunityListResource(communityKeys.bots(), { bots: [] })).toEqual({ bots: [], observed: false, source: "restored_idb" })
  })

  it("roundtrips only stable native resources and their canonical bot profile without replacing live query data", async () => {
    const client = new QueryClient()
    const liveMachines = { machines: [machine], machineCapacity: { ownedCount: 1 } }
    client.setQueryData(communityKeys.machines(), liveMachines)
    client.setQueryData(communityKeys.bots(), { bots: [bot], limit: 20 })
    client.setQueryData(communityKeys.communityDbCollection("list-viewer", "profiles"), [{ id: "bot", name: "Canonical bot", discriminator: "0042", avatar: null, avatarVersion: 5, identityComplete: true }])
    const persister = createIdbPersister("list-viewer")
    await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) })
    const restored = await persister.restoreClient()
    const queries = restored!.clientState.queries
    expect(queries.find(query => query.queryKey[1] === "machines")?.state.data).toEqual(persistentCommunityListResource(communityKeys.machines(), liveMachines))
    expect(queries.find(query => query.queryKey[1] === "machines")?.state.dataUpdatedAt).toBe(client.getQueryState(communityKeys.machines())!.dataUpdatedAt)
    expect(queries.find(query => query.queryKey[3] === "profiles")?.state.data).toEqual([expect.objectContaining({ id: "bot", name: "Canonical bot" })])
    expect(client.getQueryData(communityKeys.machines())).toBe(liveMachines)
    expect(JSON.stringify(restored)).not.toContain("private observation")
    await persister.removeClient()
    client.clear()
  })
})
