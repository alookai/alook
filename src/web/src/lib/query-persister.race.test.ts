import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import "fake-indexeddb/auto"
import { describe, expect, it, vi } from "vitest"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query"
import type { CommunityWsEvent } from "@alook/shared"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "./community-db/collections"
import { ingestServerDetail, ingestServers, reconcileCommunityRestore } from "./community-db/sync"
import { dispatchCommunityWsEvents } from "@/hooks/community/community-ws/registry"
import { communityKeys } from "./query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"

const controls = vi.hoisted(() => ({
  blockNextSet: false,
  failNextSet: false,
  releaseSet: null as (() => void) | null,
  setStarted: null as (() => void) | null,
  writes: [] as Array<{ phase: string; at: number; key: unknown; value: unknown }>,
}))

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>()
  return {
    ...actual,
    set: vi.fn(async (...args: Parameters<typeof actual.set>) => {
      controls.writes.push({ phase: "issued", at: Date.now(), key: args[0], value: args[1] })
      if (controls.blockNextSet) {
        controls.blockNextSet = false
        controls.setStarted?.()
        await new Promise<void>((resolve) => {
          controls.releaseSet = resolve
        })
      }
      if (controls.failNextSet) { controls.failNextSet = false; controls.writes.push({ phase: "failed", at: Date.now(), key: args[0], value: args[1] }); throw new Error("controlled IDB write failure") }
      await actual.set(...args)
      controls.writes.push({ phase: "committed", at: Date.now(), key: args[0], value: args[1] })
    }),
  }
})

const authorityApi = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => authorityApi(...args) }))
import { qualifyRestoredCommunityScopes } from "@/hooks/community/use-servers"

import { get } from "idb-keyval"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, filterPersistedScopeAuthority } from "./query-persister"

describe("createIdbPersister — logout race", () => {
  it("makes clear the final operation after an already-started write", async () => {
    const userId = "u_inflight_logout"
    await clearPersistedCache(userId)
    const stale = createIdbPersister(userId)
    const writeStarted = new Promise<void>((resolve) => {
      controls.setStarted = resolve
    })
    controls.blockNextSet = true

    const client: PersistedClient = {
      timestamp: 1,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    }
    const pendingWrite = stale.persistClient(client)
    await writeStarted

    // Model QueryProvider retaining a persister from an older client chunk
    // while logout imports a freshly evaluated copy of this module.
    vi.resetModules()
    const { clearPersistedCache: clearFromReloadedModule } = await import("./query-persister")
    const pendingClear = clearFromReloadedModule(userId)
    controls.releaseSet?.()
    await Promise.all([pendingWrite, pendingClear])

    expect(await get(`alook:qc:v2:${userId}:client`)).toBeUndefined()
  })
})

describe("createIdbPersister — immediate new-client restore after structural WS", () => {
  it.each(["channel-delete", "viewer-revocation", "failed-write-read-recovery"] as const)(
    "does not resurrect the invalidated scope before the throttled write: %s",
    async (scenario) => {
      const viewerId = `causal-persist-${scenario}`
      await clearPersistedCache(viewerId)
      useCommunityWsStore.getState().activateProfileAccount(viewerId)
      controls.writes = []
      const client = new QueryClient()
      const db = createCommunityDbRegistry(client, viewerId)
      await db.preload()
      const unregister = registerCommunityDbRegistry(db)
      const restoredClient = new QueryClient()
      const restoredDb = createCommunityDbRegistry(restoredClient, viewerId)
      let queuedWrite: Promise<void> | undefined
      let unregisterRestored: (() => void) | undefined
      try {
        ingestServers(db, { servers: ["target", "unaffected"].map((id) => ({ id, name: id,
          initial: id[0]!, active: false, unread: false, mentions: 0, ownerId: viewerId })) })
        for (const serverId of ["target", "unaffected"]) {
          ingestServerDetail(db, { id: serverId, name: serverId, discriminator: "0001", description: "",
            icon: null, ownerId: viewerId, categories: [{ id: `${serverId}-category`, name: "category", channels:
              (serverId === "target" ? ["leaf", "sibling"] : ["unaffected-leaf"]).map((id) => ({
                id, name: id, type: "text" as const, active: false, unread: false,
              })) }] })
        }
        const oldClock = Date.now() - 60_000
        for (const query of client.getQueryCache().getAll()) query.setState({ dataUpdatedAt: oldClock })
        const persister = createIdbPersister(viewerId)
        await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) })
        const oldDisk = await get<string>(`alook:qc:v2:${viewerId}:client`)
        expect(JSON.parse(oldDisk!).clientState.queries.find((query: { queryKey: unknown[] }) =>
          query.queryKey[3] === "channels").state.data.map((row: { id: string }) => row.id)).toContain("leaf")
        const sample = (registry: typeof db) => (["servers", "categories", "channels"] as const).map((name) => {
          const state = registry.queryClient.getQueryState(communityKeys.communityDbCollection(viewerId, name))
          return { name, data: state?.data, dataUpdatedAt: state?.dataUpdatedAt,
            status: registry.collections[name].status, rows: Array.from(registry.collections[name].values()) }
        })
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
        const event: CommunityWsEvent = scenario !== "viewer-revocation"
          ? { type: "community:channel.delete", serverId: "target", channelId: "leaf" }
          : { type: "community:member.leave", serverId: "target", userId: viewerId }
        const receiptAt = Date.now()
        dispatchCommunityWsEvents([event], { deliveryMode: "batch", queryClient: client,
          communityStore: useCommunityStore.getState(), wsStore: useCommunityWsStore.getState(),
          sub: { channelId: "leaf" }, viewerUserIdRef: { current: viewerId },
          matchesFocus: (candidate) => candidate.channelId === "leaf", scheduleInboxInvalidate: vi.fn(),
        })
        const afterReceipt = sample(db)
        expect(db.collections.channels.get("leaf")).toBeUndefined()
        expect(db.collections.channels.get("unaffected-leaf")?.id).toBe("unaffected-leaf")
        if (scenario !== "viewer-revocation") expect(db.collections.channels.get("sibling")?.id).toBe("sibling")
        queuedWrite = persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER,
          clientState: dehydrate(client) })
        if (scenario === "failed-write-read-recovery") {
          controls.failNextSet = true
          await vi.advanceTimersByTimeAsync(1000)
          await queuedWrite
        }
        const writesBeforeRestore = controls.writes.slice()
        const restored = await createIdbPersister(viewerId).restoreClient()
        unregister()
        useCommunityWsStore.getState().reset()
        useCommunityWsStore.getState().activateProfileAccount(viewerId)
        unregisterRestored = registerCommunityDbRegistry(restoredDb)
        const serverIds = new Set<string>()
        const channelIds = new Set<string>()
        restoredDb.setRestoredScopeListener((decision) => {
          if (decision.kind === "server") { serverIds.add(decision.id); for (const id of decision.channelIds) channelIds.add(id) }
        })
        authorityApi.mockImplementation(async (path: string) => {
          if (path === "/api/community/servers") return { servers: [...db.collections.servers.values()].map((server) => ({ ...server, role: "owner" })) }
          const serverId = path.split("/")[4]
          if (!db.collections.servers.has(serverId)) { const { ApiError } = await import("./errors"); throw new ApiError("denied current document", 403) }
          if (path.endsWith("/categories")) return { categories: [...db.collections.categories.values()].filter((row) => row.serverId === serverId) }
          if (path.endsWith("/channels")) return { channels: [...db.collections.channels.values()].filter((row) => row.serverId === serverId) }
          throw new Error("Unexpected authority path")
        })
        if (restored) {
          const unqualified = filterPersistedScopeAuthority(restored, viewerId, new Set(), new Set())
          hydrate(restoredClient, reconcileCommunityRestore(restoredClient, viewerId, unqualified.clientState))
          await restoredDb.preload()
          await qualifyRestoredCommunityScopes(restoredClient, viewerId, restored.clientState)
          const qualified = filterPersistedScopeAuthority(restored, viewerId, serverIds, channelIds)
          hydrate(restoredClient, reconcileCommunityRestore(restoredClient, viewerId, qualified.clientState))
        }
        restoredDb.captureRestoredCollections()
        await restoredDb.preload()
        const afterRestore = sample(restoredDb)
        const evidenceDir = resolve(process.env.ALOOK_CAUSAL_EVIDENCE_DIR ?? "../../plans/pr854-causal-controls/diagnostics")
        mkdirSync(evidenceDir, { recursive: true })
        writeFileSync(resolve(evidenceDir, `pr854_causal_persist-${scenario}.json`), JSON.stringify({ scenario, oldClock, receiptAt,
          restoreAt: Date.now(), event, oldDisk: JSON.parse(oldDisk!), afterReceipt,
          authority: { serverIds: [...serverIds], channelIds: [...channelIds], calls: authorityApi.mock.calls,
            source: "actual current-document scope acquisition plus original cache; no native runtime claim" },
          restored, afterRestore, writesBeforeRestore, writesAtRestore: controls.writes.slice() }, null, 2) + "\n")
        expect.soft(controls.writes).toHaveLength(writesBeforeRestore.length)
        expect.soft(restoredDb.collections.channels.get("leaf")).toBeUndefined()
        expect.soft(restoredDb.collections.channels.get("unaffected-leaf")?.id).toBe("unaffected-leaf")
        if (scenario !== "viewer-revocation") expect.soft(restoredDb.collections.channels.get("sibling")?.id).toBe("sibling")
        else expect.soft(restoredDb.collections.servers.get("target")).toBeUndefined()
      } finally {
        if (queuedWrite) {
          await vi.advanceTimersByTimeAsync(1000)
          await queuedWrite
        }
        vi.useRealTimers()
        unregister()
        unregisterRestored?.()
        await Promise.all([db.cleanup(), restoredDb.cleanup()])
        await Promise.all([client.cancelQueries(), restoredClient.cancelQueries()])
        client.clear()
        restoredClient.clear()
        await clearPersistedCache(viewerId)
      }
    },
  )
})
