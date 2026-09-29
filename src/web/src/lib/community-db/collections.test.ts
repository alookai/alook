import { QueryClient } from "@tanstack/react-query"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createCommunityDbRegistry,
  getCommunityDbRegistryBinding,
  observeCommunityDbLifecycleCommit,
  observeCommunityDbLifecycleLoadSubset,
  observeCommunityDbLifecycleReceipt,
  registerCommunityDbRegistry,
  subscribeCommunityDbRegistryBinding,
  type CommunityDbRegistry,
} from "./collections"
import { writeCommunityCollectionRows } from "./collection-mutations"
import type { AttentionItemRow, MessageRow } from "./schema"
import { serversCollectionQueryKey } from "./server-collection"

let registry: CommunityDbRegistry | null = null

afterEach(() => {
  registry?.cleanup()
  registry = null
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_REGISTRY_SEQUENCE__")
  Reflect.deleteProperty(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_SEQUENCE__")
  Reflect.deleteProperty(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_STORE__")
})

describe("community collection readiness", () => {
  it("keeps lifecycle diagnostics inert until the runtime opts in", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await registry.ensureCollectionReady("servers")

    expect(registry.getLifecycleTimeline()).toBeNull()
  })

  it("records bounded server lifecycle events from observable boundaries", async () => {
    vi.stubGlobal("__ALOOK_COMMUNITY_DB_TRACE_RUN_ID__", "run-unit-lifecycle")
    const queryClient = new QueryClient()
    const server = {
      id: "s1",
      position: 0,
      name: "Server",
      discriminator: "0001",
      description: "",
      ownerId: "viewer",
      icon: null,
      official: false,
      isOwner: true,
      unread: false,
      mentions: 0,
      detailComplete: false,
    }
    queryClient.setQueryData(serversCollectionQueryKey(), {
      servers: [server],
      unreadSources: [],
    })
    const persistence: PersistedCollectionPersistence = {
      adapter: {
        applyCommittedTx: async () => {},
        ensureIndex: async () => {},
        loadSubset: async () => [],
      },
    }
    registry = createCommunityDbRegistry(queryClient, "viewer", { persistence })
    await registry.ensureCollectionReady("servers")

    const timeline = registry.getLifecycleTimeline()
    expect(timeline).toMatchObject({ dropped: 0, runId: "run-unit-lifecycle" })
    expect(timeline?.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "forward:mark-ready",
      "readiness:preloading",
      "readiness:ready",
      "select:input",
      "select:output",
      "source:commit-call",
    ]))
    expect(timeline?.events.every((event) => (
      event.runId === "run-unit-lifecycle"
      && event.registryId === "registry-1"
      && event.seq > 0
      && event.at >= 0
      && typeof event.snapshot.visible.summary.rows === "number"
      && typeof event.snapshot.synced.summary.rows === "number"
    ))).toBe(true)
    const rowStates = timeline?.events.flatMap((event) => [
      ...event.snapshot.visible.rows,
      ...event.snapshot.synced.rows,
    ]) ?? []
    expect(rowStates).toContainEqual({ detailComplete: false, row: "row-1" })
    expect(rowStates.every((row) => /^row-\d+$/.test(row.row))).toBe(true)
    const sourceTxIds = new Set(timeline?.events
      .filter((event) => event.kind === "source:begin")
      .map((event) => event.detail.txId))
    const forwardedTxIds = timeline?.events
      .filter((event) => event.kind === "forward:begin" && event.detail.origin !== "unknown")
      .map((event) => event.detail.txId) ?? []
    expect(forwardedTxIds.length).toBeGreaterThan(0)
    expect(forwardedTxIds.every((txId) => sourceTxIds.has(txId))).toBe(true)
    expect(JSON.stringify(timeline)).not.toContain("Server")
    expect(JSON.stringify(timeline)).not.toContain("viewer")
    expect(JSON.stringify(timeline)).not.toContain("s1")

    for (let index = 0; index < 80; index += 1) {
      registry.collections.servers.utils.writeUpdate({ id: "s1", name: `Server ${index}` })
    }
    await vi.waitFor(() => {
      expect(registry?.getLifecycleTimeline()?.dropped).toBeGreaterThan(0)
    })
    const boundedTimeline = registry.getLifecycleTimeline()
    expect(boundedTimeline?.events).toHaveLength(512)
    expect(JSON.stringify(boundedTimeline)).not.toContain("Server 79")
  })

  it("correlates consecutive deep-equal query results by application generation", async () => {
    vi.stubGlobal("__ALOOK_COMMUNITY_DB_TRACE_RUN_ID__", "run-query-generation")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        id: "s1",
        name: "Server",
        discriminator: "0001",
        ownerId: "viewer",
        icon: null,
        role: "owner",
      }],
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })))
    registry = createCommunityDbRegistry(new QueryClient(), "viewer", {
      serverTransport: true,
    })

    await registry.ensureCollectionReady("servers")
    await registry.requestServerRefetch()

    const events = registry.getLifecycleTimeline()?.events ?? []
    expect(events.filter((event) => event.kind === "query:result").map((event) => (
      event.detail.queryId
    ))).toEqual(["query-1", "query-2"])
    for (const queryId of ["query-1", "query-2"]) {
      const chain = events.filter((event) => event.detail.queryId === queryId)
      const kinds = chain.map((event) => event.kind)
      expect(kinds).toEqual(expect.arrayContaining([
        "query:result",
        "select:input",
        "select:output",
        "source:begin",
        "forward:begin",
      ]))
      expect(kinds.indexOf("query:result")).toBeLessThan(kinds.indexOf("select:input"))
      expect(kinds.indexOf("select:input")).toBeLessThan(kinds.indexOf("source:begin"))
      expect(kinds.indexOf("source:begin")).toBeLessThan(kinds.indexOf("forward:begin"))
    }
    const selectApplications = events.filter((event) => (
      event.kind === "select:input" && ["query-1", "query-2"].includes(String(event.detail.queryId))
    )).map((event) => event.detail.applicationId)
    expect(new Set(selectApplications).size).toBe(2)
  })

  it("keeps one transaction id across source and forward while hydration is pending", async () => {
    vi.stubGlobal("__ALOOK_COMMUNITY_DB_TRACE_RUN_ID__", "run-buffered-correlation")
    let markHydrationStarted!: () => void
    let releaseHydration!: () => void
    const hydrationStarted = new Promise<void>((resolve) => { markHydrationStarted = resolve })
    const hydration = new Promise<void>((resolve) => { releaseHydration = resolve })
    const persistence: PersistedCollectionPersistence = {
      adapter: {
        applyCommittedTx: async () => {},
        ensureIndex: async () => {},
        loadSubset: async () => {
          markHydrationStarted()
          await hydration
          return []
        },
      },
    }
    const queryClient = new QueryClient()
    queryClient.setQueryData(serversCollectionQueryKey(), {
      servers: [{
        id: "s1",
        position: 0,
        name: "Server",
        discriminator: "0001",
        description: "",
        ownerId: "viewer",
        icon: null,
        official: false,
        isOwner: true,
        unread: false,
        mentions: 0,
        detailComplete: false,
      }],
      unreadSources: [],
    })
    registry = createCommunityDbRegistry(queryClient, "viewer", { persistence })
    const ready = registry.ensureCollectionReady("servers")
    await hydrationStarted
    registry.collections.servers.utils.writeUpdate({ id: "s1", detailComplete: true })

    await vi.waitFor(() => {
      expect(registry?.getLifecycleTimeline()?.events.some((event) => (
        event.kind === "source:commit-status"
        && event.detail.origin === "manual"
        && event.detail.pending === true
      ))).toBe(true)
    })
    const beforeHydration = registry.getLifecycleTimeline()
    const sourceTxId = beforeHydration?.events.find((event) => (
      event.kind === "source:commit-status"
      && event.detail.origin === "manual"
      && event.detail.pending === true
    ))?.detail.txId
    expect(sourceTxId).toMatch(/^tx-\d+$/)
    const correlatedKinds = beforeHydration?.events.filter((event) => (
      event.detail.txId === sourceTxId
    )).map((event) => event.kind) ?? []
    expect(correlatedKinds).toEqual(expect.arrayContaining([
      "source:begin",
      "source:commit-status",
      "forward:begin",
      "forward:commit-status",
    ]))

    releaseHydration()
    await ready
    await vi.waitFor(() => {
      expect(registry?.getLifecycleTimeline()?.events.some((event) => (
        event.kind === "forward:begin" && event.detail.txId === sourceTxId
      ))).toBe(true)
    })
  })

  it("observes receipt settlement without replacing the receipt", async () => {
    let resolve!: () => void
    const receipt = new Promise<void>((done) => { resolve = done })
    const settled = vi.fn()
    const rejected = vi.fn()

    expect(observeCommunityDbLifecycleReceipt(receipt, settled, rejected)).toBe(receipt)
    expect(observeCommunityDbLifecycleReceipt(true, settled, rejected)).toBe(true)
    expect(settled).toHaveBeenCalledOnce()
    resolve()
    await receipt
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2))
    expect(rejected).not.toHaveBeenCalled()
  })

  it("keeps receipt behavior when diagnostic callbacks throw", async () => {
    let resolve!: () => void
    const receipt = new Promise<void>((done) => { resolve = done })
    const throwingCallback = vi.fn(() => {
      throw new Error("diagnostic callback failed")
    })

    expect(observeCommunityDbLifecycleReceipt(true, throwingCallback, throwingCallback)).toBe(true)
    expect(observeCommunityDbLifecycleReceipt(receipt, throwingCallback, throwingCallback)).toBe(receipt)
    resolve()
    await expect(receipt).resolves.toBeUndefined()
    await vi.waitFor(() => expect(throwingCallback).toHaveBeenCalledTimes(2))
  })

  it("preserves receipts through the wrapped commit and loadSubset boundaries", async () => {
    const commitReceipt = Promise.resolve()
    const loadSubsetReceipt = Promise.resolve()
    const record = vi.fn()
    const commit = observeCommunityDbLifecycleCommit(
      () => commitReceipt,
      record,
      "source",
      { txId: "tx-1" },
    )
    const loadSubset = observeCommunityDbLifecycleLoadSubset(
      () => loadSubsetReceipt,
      record,
      () => "load-1",
    )

    expect(commit()).toBe(commitReceipt)
    expect(loadSubset({})).toBe(loadSubsetReceipt)
    await Promise.all([commitReceipt, loadSubsetReceipt])
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith("source:commit-settle", expect.any(Object))
      expect(record).toHaveBeenCalledWith("loadSubset:settle", expect.any(Object))
    })
  })

  it("keeps wrapped receipts intact when diagnostic recording throws", async () => {
    const receipt = Promise.resolve()
    const record = () => {
      throw new Error("diagnostic recorder failed")
    }

    expect(observeCommunityDbLifecycleCommit(
      () => receipt,
      record,
      "forward",
      { txId: "tx-1" },
    )()).toBe(receipt)
    expect(observeCommunityDbLifecycleLoadSubset(
      () => receipt,
      record,
      () => "load-1",
    )({})).toBe(receipt)
    await expect(receipt).resolves.toBeUndefined()
  })

  it("keeps the newest registry binding when an older registration releases", async () => {
    const queryClient = new QueryClient()
    const first = createCommunityDbRegistry(queryClient, "viewer")
    const second = createCommunityDbRegistry(queryClient, "viewer")
    const listener = vi.fn()
    const unsubscribe = subscribeCommunityDbRegistryBinding(queryClient, listener)
    const unregisterFirst = registerCommunityDbRegistry(first)
    const firstBinding = getCommunityDbRegistryBinding(queryClient)
    const unregisterSecond = registerCommunityDbRegistry(second)
    const secondBinding = getCommunityDbRegistryBinding(queryClient)

    expect(firstBinding?.registry).toBe(first)
    expect(firstBinding?.generation).toBe(1)
    expect(secondBinding?.registry).toBe(second)
    expect(secondBinding?.generation).toBe(2)
    unregisterFirst()
    expect(getCommunityDbRegistryBinding(queryClient)).toBe(secondBinding)
    unregisterSecond()
    expect(getCommunityDbRegistryBinding(queryClient)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    await Promise.all([first.cleanup(), second.cleanup()])
  })

  it("owns one preload promise and publishes ready only after it resolves", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    const collection = registry.collections.messages
    const originalPreload = collection.preload.bind(collection)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const preload = vi.spyOn(collection, "preload").mockImplementation(async () => {
      await gate
      await originalPreload()
    })
    const listener = vi.fn()
    registry.subscribeCollectionReadiness(listener)

    const first = registry.ensureCollectionReady("messages")
    const second = registry.ensureCollectionReady("messages")
    expect(first).toBe(second)
    expect(registry.getCollectionReadiness("messages")).toBe("preloading")
    expect(registry.isCollectionReady("messages")).toBe(false)
    expect(preload).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(preload).toHaveBeenCalledOnce()
    release()
    await first
    expect(registry.getCollectionReadiness("messages")).toBe("ready")
    expect(registry.isCollectionReady("messages")).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("rejects writes to an already-ready collection after another preload fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const failure = new Error("messages preload failed")
    vi.spyOn(registry.collections.messages, "preload").mockRejectedValueOnce(failure)

    await expect(registry.ensureCollectionReady("messages")).rejects.toBe(failure)
    const committed = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )

    await expect(committed).rejects.toBe(failure)
    expect(registry.collections.profiles.has("alice")).toBe(false)
  })

  it("fences a durable write queued before another collection fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-durable-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const profiles = registry.collections.profiles
    let releasePersistence!: () => void
    const persistence = new Promise<void>((resolve) => { releasePersistence = resolve })
    Object.assign(profiles.utils, { getLeadershipState: vi.fn() })
    const acceptMutations = vi.spyOn(profiles.utils, "acceptMutations")
      .mockImplementationOnce(() => persistence)
    const first = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )
    await vi.waitFor(() => expect(acceptMutations).toHaveBeenCalledOnce())
    const second = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "B", avatarVersion: 0 }],
      (row) => row.userId,
    )
    const failure = new Error("messages preload failed")
    vi.spyOn(registry.collections.messages, "preload").mockRejectedValueOnce(failure)
    await expect(registry.ensureCollectionReady("messages")).rejects.toBe(failure)

    releasePersistence()
    await first
    await expect(second).rejects.toBe(failure)
    expect(acceptMutations).toHaveBeenCalledOnce()
    expect(profiles.has("bob")).toBe(false)
  })
})

describe("community message retention", () => {
  it("keeps the active scope, 20 inactive tails, and attention-referenced rows", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await registry.preload()
    registry.activateMessageScope("scope-0")
    const messages: MessageRow[] = Array.from({ length: 22 }, (_, scope) => (
      Array.from({ length: 60 }, (_, index) => ({
        id: `m-${scope}-${index}`,
        channelId: `scope-${scope}`,
        type: "chat" as const,
        createdAt: new Date(Date.UTC(2026, 0, scope + 1, 0, index)).toISOString(),
      }))
    )).flat()
    writeCommunityCollectionRows(registry, "messages", messages, (row) => row.id)
    const attention: AttentionItemRow = {
      id: "attention-1",
      kind: "mention",
      sourceId: "source-1",
      scopeId: "scope-1",
      messageId: "m-1-0",
      actorUserId: "actor-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    writeCommunityCollectionRows(
      registry,
      "attentionItems",
      [attention],
      (row) => row.id,
    )
    await registry.preload()

    await registry.pruneMessageRetention()

    const retained = [...registry.collections.messages.values()]
    expect(retained.filter((row) => row.channelId === "scope-0")).toHaveLength(60)
    expect(retained.filter((row) => row.channelId === "scope-1").map((row) => row.id))
      .toEqual(["m-1-0"])
    expect(retained.filter((row) => row.channelId === "scope-2")).toHaveLength(50)
    expect(retained.filter((row) => row.channelId === "scope-21")).toHaveLength(50)
    expect(new Set(retained.map((row) => row.channelId)).size).toBe(22)
  })
})
