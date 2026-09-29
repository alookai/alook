import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"

const adapter = vi.hoisted(() => ({
  applyCommittedTx: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  create: vi.fn(() => ({
    adapter: {
      applyCommittedTx: adapter.applyCommittedTx,
      ensureIndex: adapter.ensureIndex,
      loadSubset: adapter.loadSubset,
    },
  })),
  dispose: vi.fn(),
  ensureIndex: vi.fn(() => Promise.resolve()),
  execute: vi.fn((sql: string) => Promise.resolve([
    sql.includes("page_count")
      ? { page_count: 4 }
      : sql.includes("page_size")
        ? { page_size: 1024 }
        : { freelist_count: 0 },
  ])),
  loadSubset: vi.fn(() => Promise.resolve([])),
  open: vi.fn(),
}))

vi.mock("@tanstack/browser-db-sqlite-persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/browser-db-sqlite-persistence")>()
  return {
    ...actual,
    BrowserCollectionCoordinator: class {
      dispose = adapter.dispose
      ensureLeadership = vi.fn(() => Promise.resolve())
      getNodeId = vi.fn(() => "browser-persistence-test-node")
      isLeader = vi.fn(() => true)
      publish = vi.fn()
      requestEnsurePersistedIndex = vi.fn(() => Promise.resolve())
      subscribe = vi.fn(() => () => {})
    },
    createBrowserWASQLitePersistence: adapter.create,
    openBrowserWASQLiteOPFSDatabase: adapter.open,
  }
})

import {
  clearAllPersistedCaches,
  formatBytes,
  getBrowserPersistenceRuntime,
  getPersistedCacheSizeBytes,
  rebuildBrowserPersistenceRuntime,
  registerPersistenceClearScope,
  resetBrowserPersistenceForTests,
} from "./browser-persistence"

const originalNavigator = globalThis.navigator

function enableCapabilities() {
  vi.stubGlobal("Worker", class {})
  vi.stubGlobal("BroadcastChannel", class {})
  vi.stubGlobal("navigator", {
    ...originalNavigator,
    storage: { getDirectory: vi.fn() },
    locks: { request: vi.fn() },
  })
}

beforeEach(async () => {
  await resetBrowserPersistenceForTests()
  adapter.applyCommittedTx.mockClear()
  adapter.close.mockClear()
  adapter.create.mockClear()
  adapter.dispose.mockClear()
  adapter.ensureIndex.mockClear()
  adapter.execute.mockReset()
  adapter.execute.mockImplementation((sql: string) => Promise.resolve([
    sql.includes("page_count")
      ? { page_count: 4 }
      : sql.includes("page_size")
        ? { page_size: 1024 }
        : { freelist_count: 0 },
  ]))
  adapter.loadSubset.mockClear()
  adapter.open.mockReset()
  adapter.open.mockResolvedValue({
    close: adapter.close,
    execute: adapter.execute,
  })
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser persistence runtime", () => {
  it.each([
    ["Web Worker", () => {
      enableCapabilities()
      vi.stubGlobal("Worker", undefined)
    }],
    ["BroadcastChannel", () => {
      enableCapabilities()
      vi.stubGlobal("BroadcastChannel", undefined)
    }],
    ["OPFS", () => {
      enableCapabilities()
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        storage: {},
        locks: { request: vi.fn() },
      })
    }],
    ["Web Locks", () => {
      enableCapabilities()
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        storage: { getDirectory: vi.fn() },
        locks: {},
      })
    }],
  ])("uses memory without another durable adapter when %s is unavailable", async (
    _capability,
    disableCapability,
  ) => {
    disableCapability()

    const runtime = await getBrowserPersistenceRuntime()

    await waitFor(() => expect(runtime.mode).toBe("memory"))
    expect(runtime.persistence).toBeNull()
    expect(await runtime.inspectCollection("messages")).toBeNull()
    expect(adapter.open).not.toHaveBeenCalled()
  })

  it("does not mark legacy cleanup complete when a database deletion is blocked", async () => {
    const deleteDatabase = vi.fn((name: string) => {
      const request: {
        onblocked?: () => void
        onerror?: () => void
        onsuccess?: () => void
      } = {}
      queueMicrotask(() => {
        if (name === "keyval-store") request.onblocked?.()
        else request.onsuccess?.()
      })
      return request
    })
    vi.stubGlobal("indexedDB", {
      databases: vi.fn(() => Promise.resolve([
        { name: "keyval-store" },
        { name: "alook-chat-cache-workspace-a" },
      ])),
      deleteDatabase,
    })

    await getBrowserPersistenceRuntime()

    await waitFor(() => expect(deleteDatabase).toHaveBeenCalledTimes(2))
    expect(localStorage.getItem("alook:persistence:legacy-cleaned:v1")).toBeNull()
  })

  it("marks successful legacy cleanup and tolerates unavailable storage APIs", async () => {
    const deleteDatabase = vi.fn(() => {
      const request: { onsuccess?: () => void } = {}
      queueMicrotask(() => request.onsuccess?.())
      return request
    })
    const databases = vi.fn(() => Promise.resolve([
      { name: "keyval-store" },
      { name: "alook-chat-cache-workspace-a" },
      { name: "unrelated" },
    ]))
    vi.stubGlobal("indexedDB", { databases, deleteDatabase })

    await getBrowserPersistenceRuntime()
    await waitFor(() => expect(deleteDatabase).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localStorage.getItem(
      "alook:persistence:legacy-cleaned:v1",
    )).toBe("1"))

    await resetBrowserPersistenceForTests()
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })
    await getBrowserPersistenceRuntime()
    await waitFor(() => expect(getItem).toHaveBeenCalled())
    getItem.mockRestore()

    await resetBrowserPersistenceForTests()
    localStorage.clear()
    databases.mockRejectedValueOnce(new Error("enumeration blocked"))
    await getBrowserPersistenceRuntime()
    await waitFor(() => expect(databases).toHaveBeenCalled())
  })

  it("leaves the cleanup marker unset when IndexedDB deletion throws", async () => {
    const deleteDatabase = vi.fn(() => {
      throw new Error("delete blocked")
    })
    vi.stubGlobal("indexedDB", {
      databases: vi.fn(() => Promise.resolve([{ name: "keyval-store" }])),
      deleteDatabase,
    })

    await getBrowserPersistenceRuntime()
    await waitFor(() => expect(deleteDatabase).toHaveBeenCalled())
    expect(localStorage.getItem("alook:persistence:legacy-cleaned:v1")).toBeNull()
  })

  it("opens one coordinated OPFS database and reports its SQLite size", async () => {
    enableCapabilities()

    const runtime = await getBrowserPersistenceRuntime()

    expect(runtime.mode).toBe("persistent")
    expect(adapter.open).toHaveBeenCalledWith({
      databaseName: "alook-tanstack-db-v1.sqlite",
    })
    expect(await runtime.sizeBytes()).toBe(4096)
    await runtime.close()
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(adapter.close).toHaveBeenCalledOnce()
  })

  it("inspects persisted collection mappings and fences closed runtimes", async () => {
    enableCapabilities()
    const runtime = await getBrowserPersistenceRuntime()
    adapter.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ collection_id: "bad", schema_version: 1, table_name: "bad-name", tombstone_table_name: "bad_tombstones" }])
      .mockResolvedValueOnce([{ collection_id: "messages", schema_version: 2, table_name: "messages_v2", tombstone_table_name: "messages_v2_tombstones" }])
      .mockResolvedValueOnce([{ key: "a" }, { key: "b" }])

    expect(await runtime.inspectCollection("missing")).toBeNull()
    expect(await runtime.inspectCollection("bad")).toBeNull()
    expect(await runtime.inspectCollection("messages")).toEqual({
      collectionId: "messages",
      rowKeys: ["a", "b"],
      schemaVersion: 2,
      tableName: "messages_v2",
      tombstoneTableName: "messages_v2_tombstones",
    })

    await runtime.close()
    expect(await runtime.inspectCollection("messages")).toBeNull()
  })

  it("rebuilds by closing and discarding the active runtime", async () => {
    enableCapabilities()
    const first = await getBrowserPersistenceRuntime()

    await rebuildBrowserPersistenceRuntime()
    const second = await getBrowserPersistenceRuntime()

    expect(second).not.toBe(first)
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(adapter.close).toHaveBeenCalledOnce()
    expect(adapter.open).toHaveBeenCalledTimes(2)
  })

  it("clears an inactive account through a temporary persisted registry", async () => {
    enableCapabilities()
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.endsWith("/api/community/users/me/read-state")
        ? { revision: 0, readStates: [] }
        : url.endsWith("/api/community/users/me/attention")
          ? {
              scopes: [], items: [], limit: 100, truncated: false,
              included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
            }
          : url.endsWith("/api/community/users/me/dms")
            ? { conversations: [] }
        : url.endsWith("/api/community/users/me/server-folders")
          ? { folders: [] }
          : url.endsWith("/api/community/users/me/notifications")
            ? []
            : null
      if (body === null) throw new Error(`unexpected API fetch: ${url}`)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }))
    await getBrowserPersistenceRuntime()
    const { clearCommunityPersistenceForAccount } = await import("./community-db/collections")

    await clearCommunityPersistenceForAccount("inactive-account")

    expect(adapter.loadSubset).toHaveBeenCalled()
  })

  it("falls back to memory when the OPFS worker cannot initialize", async () => {
    enableCapabilities()
    adapter.open.mockRejectedValueOnce(new Error("worker blocked"))

    const runtime = await getBrowserPersistenceRuntime()

    expect(runtime.mode).toBe("memory")
    expect(runtime.reason).toContain("worker blocked")
    expect(adapter.create).not.toHaveBeenCalled()
    expect(await runtime.sizeBytes()).toBeNull()
    await runtime.close()
  })

  it("reports unavailable SQLite size data without failing the runtime", async () => {
    enableCapabilities()
    adapter.execute.mockRejectedValueOnce(new Error("pragma blocked"))
    const runtime = await getBrowserPersistenceRuntime()
    expect(await runtime.sizeBytes()).toBeNull()

    adapter.execute.mockReset()
    adapter.execute.mockResolvedValue([])
    expect(await runtime.sizeBytes()).toBeNull()
    await runtime.close()
    expect(await runtime.sizeBytes()).toBeNull()
  })

  it("clears registered scopes by prefix and formats reported sizes", async () => {
    enableCapabilities()
    const agentA = vi.fn(() => Promise.resolve())
    const agentB = vi.fn(() => Promise.resolve())
    const community = vi.fn(() => Promise.resolve())
    const unregisterA = registerPersistenceClearScope("agent:a", agentA)
    registerPersistenceClearScope("agent:b", agentB)
    registerPersistenceClearScope("community:a", community)

    await clearAllPersistedCaches("agent:")
    expect(agentA).toHaveBeenCalledOnce()
    expect(agentB).toHaveBeenCalledOnce()
    expect(community).not.toHaveBeenCalled()
    unregisterA()
    await clearAllPersistedCaches()
    expect(agentA).toHaveBeenCalledOnce()
    expect(agentB).toHaveBeenCalledTimes(2)
    expect(community).toHaveBeenCalledOnce()

    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(2 * 1024 ** 2)).toBe("2.0 MB")
    expect(await getPersistedCacheSizeBytes()).toBe(4096)
  })
})

type OfficialPersistencePackage = typeof import("@tanstack/browser-db-sqlite-persistence")

type AdapterWithStreamPosition = OfficialPersistencePackage["createBrowserWASQLitePersistence"] extends (
  ...args: never[]
) => infer TPersistence
  ? TPersistence extends { adapter: infer TAdapter }
    ? TAdapter & {
      getStreamPosition?: (collectionId: string) => Promise<{
        latestTerm: number
        latestSeq: number
        latestRowVersion: number
      }>
    }
    : never
  : never

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function officialRuntime() {
  vi.resetModules()
  const actual = await vi.importActual<OfficialPersistencePackage>(
    "@tanstack/browser-db-sqlite-persistence",
  )
  const database = {
    close: vi.fn(() => Promise.resolve()),
    execute: vi.fn(() => Promise.resolve([])),
  }
  const broadcastChannels: Array<{ close: ReturnType<typeof vi.fn> }> = []
  class TestBroadcastChannel {
    close = vi.fn()
    onmessage: ((event: MessageEvent) => void) | null = null
    postMessage = vi.fn()

    constructor(_name: string) {
      broadcastChannels.push(this)
    }
  }
  vi.stubGlobal("Worker", class {})
  vi.stubGlobal("BroadcastChannel", TestBroadcastChannel)
  vi.stubGlobal("navigator", {
    ...originalNavigator,
    storage: { getDirectory: vi.fn() },
    locks: {
      request: vi.fn(async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<void>,
      ) => callback()),
    },
  })
  vi.doMock("@tanstack/browser-db-sqlite-persistence", () => ({
    ...actual,
    openBrowserWASQLiteOPFSDatabase: vi.fn(() => Promise.resolve(database)),
  }))
  const runtimeModule = await import("./browser-persistence")
  const runtime = await runtimeModule.getBrowserPersistenceRuntime()
  if (!runtime.persistence) throw new Error("official persistence runtime unavailable")
  return { actual, broadcastChannels, database, runtime, runtimeModule }
}

function resolveOfficialAdapters(
  persistence: NonNullable<Awaited<ReturnType<typeof officialRuntime>>["runtime"]["persistence"]>,
) {
  const resolveCollection = persistence.resolvePersistenceForCollection
  const resolveMode = persistence.resolvePersistenceForMode
  if (!resolveCollection || !resolveMode) {
    throw new Error("official persistence resolvers unavailable")
  }
  const collectionId = "community-db:test:servers"
  const servers = resolveCollection({ collectionId, mode: "sync-present", schemaVersion: 1 })
  const serversAgain = resolveCollection({ collectionId, mode: "sync-present", schemaVersion: 1 })
  const channels = resolveCollection({
    collectionId: "community-db:test:channels",
    mode: "sync-present",
    schemaVersion: 2,
  })
  const mode = resolveMode("sync-present")
  return { channels, collectionId, mode, servers, serversAgain }
}

describe("official browser coordinator adapter routing", () => {
  it("keeps a clean-db servers preload and leader restore on the v1 adapter", async () => {
    const { actual, broadcastChannels, database, runtime, runtimeModule } = await officialRuntime()
    const { channels, collectionId, mode, servers, serversAgain } = resolveOfficialAdapters(
      runtime.persistence!,
    )
    const preloadStarted = deferred()
    const releasePreload = deferred()
    const preloadFinished = deferred()
    const v1Restore = vi.fn(async () => {
      await preloadFinished.promise
      return { latestTerm: 0, latestSeq: 0, latestRowVersion: 0 }
    })
    const v2Restore = vi.fn(async () => (
      { latestTerm: 0, latestSeq: 0, latestRowVersion: 0 }
    ))
    ;(servers.adapter as AdapterWithStreamPosition).loadSubset = vi.fn(async () => {
      preloadStarted.resolve()
      await releasePreload.promise
      preloadFinished.resolve()
      return []
    })
    ;(servers.adapter as AdapterWithStreamPosition).getStreamPosition = v1Restore
    ;(channels.adapter as AdapterWithStreamPosition).getStreamPosition = v2Restore

    const preload = servers.adapter.loadSubset(collectionId, {})
    await preloadStarted.promise
    const unsubscribe = servers.coordinator!.subscribe(collectionId, () => {})
    try {
      await waitFor(() => expect(v1Restore.mock.calls.length + v2Restore.mock.calls.length).toBe(1))
      releasePreload.resolve()
      await preload

      expect(runtime.persistence!.coordinator).toBe(mode.coordinator)
      expect(mode.adapter).toBe(runtime.persistence!.adapter)
      expect(serversAgain.adapter).toBe(servers.adapter)
      expect(serversAgain.coordinator).toBe(servers.coordinator)
      expect(servers.coordinator).toBeInstanceOf(actual.BrowserCollectionCoordinator)
      expect(channels.coordinator).toBeInstanceOf(actual.BrowserCollectionCoordinator)
      expect(channels.coordinator).not.toBe(servers.coordinator)
      expect(v1Restore).toHaveBeenCalledWith(collectionId)
      expect(v2Restore).not.toHaveBeenCalled()
    } finally {
      releasePreload.resolve()
      preloadFinished.resolve()
      unsubscribe()
      await runtimeModule.resetBrowserPersistenceForTests()
    }
    expect(database.close).toHaveBeenCalledOnce()
    expect(broadcastChannels.length).toBeGreaterThanOrEqual(3)
    expect(broadcastChannels.every(({ close }) => close.mock.calls.length === 1)).toBe(true)
  })

  it("keeps an existing v1 servers registry on v1 after resolving v2", async () => {
    const { actual, runtime, runtimeModule } = await officialRuntime()
    const { channels, collectionId, servers } = resolveOfficialAdapters(runtime.persistence!)
    const registry = new Map([[collectionId, { schemaVersion: 1, tableReady: true }]])
    const v1Restore = vi.fn(async (id: string) => {
      expect(registry.get(id)).toEqual({ schemaVersion: 1, tableReady: true })
      return { latestTerm: 2, latestSeq: 3, latestRowVersion: 4 }
    })
    const v2Restore = vi.fn(async (id: string) => {
      registry.set(id, { schemaVersion: 2, tableReady: false })
      return { latestTerm: 0, latestSeq: 0, latestRowVersion: 0 }
    })
    ;(servers.adapter as AdapterWithStreamPosition).getStreamPosition = v1Restore
    ;(channels.adapter as AdapterWithStreamPosition).getStreamPosition = v2Restore

    const unsubscribe = servers.coordinator!.subscribe(collectionId, () => {})
    try {
      await waitFor(() => expect(v1Restore.mock.calls.length + v2Restore.mock.calls.length).toBe(1))

      expect(servers.coordinator).toBeInstanceOf(actual.BrowserCollectionCoordinator)
      expect(channels.coordinator).not.toBe(servers.coordinator)
      expect(v1Restore).toHaveBeenCalledWith(collectionId)
      expect(v2Restore).not.toHaveBeenCalled()
      expect(registry.get(collectionId)).toEqual({ schemaVersion: 1, tableReady: true })
    } finally {
      unsubscribe()
      await runtimeModule.resetBrowserPersistenceForTests()
    }
  })
})
