import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"

const adapter = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  create: vi.fn(() => ({ kind: "persistence" })),
  dispose: vi.fn(),
  execute: vi.fn((sql: string) => Promise.resolve([
    sql.includes("page_count")
      ? { page_count: 4 }
      : sql.includes("page_size")
        ? { page_size: 1024 }
        : { freelist_count: 0 },
  ])),
  open: vi.fn(),
}))

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  BrowserCollectionCoordinator: class {
    dispose = adapter.dispose
  },
  createBrowserWASQLitePersistence: adapter.create,
  openBrowserWASQLiteOPFSDatabase: adapter.open,
}))

import {
  clearAllPersistedCaches,
  formatBytes,
  getBrowserPersistenceRuntime,
  getPersistedCacheSizeBytes,
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
  adapter.close.mockClear()
  adapter.create.mockClear()
  adapter.dispose.mockClear()
  adapter.execute.mockReset()
  adapter.execute.mockImplementation((sql: string) => Promise.resolve([
    sql.includes("page_count")
      ? { page_count: 4 }
      : sql.includes("page_size")
        ? { page_size: 1024 }
        : { freelist_count: 0 },
  ]))
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
