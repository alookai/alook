import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  type BrowserWASQLiteDatabase,
  type PersistedCollectionPersistence,
} from "@tanstack/browser-db-sqlite-persistence"

const DATABASE_NAME = "alook-tanstack-db-v1.sqlite"
const COORDINATOR_NAME = "alook-tanstack-db-v1"
const LEGACY_CLEANUP_MARKER = "alook:persistence:legacy-cleaned:v1"
const LEGACY_QUERY_DATABASE = "keyval-store"
const LEGACY_CHAT_DATABASE_PREFIX = "alook-chat-cache-"

type BrowserPersistenceMode = "persistent" | "memory"

export type BrowserPersistenceRuntime = {
  mode: BrowserPersistenceMode
  persistence: PersistedCollectionPersistence | null
  reason: string | null
  close: () => Promise<void>
  sizeBytes: () => Promise<number | null>
}

type ClearScope = {
  clear: () => Promise<void>
  key: string
}

type PersistenceGlobal = typeof globalThis & {
  __alookBrowserPersistenceV1?: Promise<BrowserPersistenceRuntime>
  __alookPersistenceClearScopesV1?: Map<string, ClearScope>
}

function persistenceGlobal(): PersistenceGlobal {
  return globalThis as PersistenceGlobal
}

function clearScopes(): Map<string, ClearScope> {
  const global = persistenceGlobal()
  global.__alookPersistenceClearScopesV1 ??= new Map()
  return global.__alookPersistenceClearScopesV1
}

function capabilityFailure(): string | null {
  if (typeof window === "undefined") return "server runtime"
  if (typeof Worker !== "function") return "Web Worker unavailable"
  if (typeof BroadcastChannel !== "function") return "BroadcastChannel unavailable"
  if (typeof navigator.storage?.getDirectory !== "function") return "OPFS unavailable"
  if (typeof navigator.locks?.request !== "function") return "Web Locks unavailable"
  return null
}

function deleteIndexedDb(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
      request.onblocked = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

async function cleanupLegacyDatabases(): Promise<void> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return
  try {
    if (window.localStorage.getItem(LEGACY_CLEANUP_MARKER) === "1") return
  } catch {
    return
  }

  if (typeof indexedDB.databases !== "function") return
  let databases: IDBDatabaseInfo[] | null = null
  try {
    databases = await indexedDB.databases()
  } catch {
    return
  }
  if (!databases) return
  const queryDeleted = await deleteIndexedDb(LEGACY_QUERY_DATABASE)
  const chatResults = await Promise.all(databases.flatMap(({ name }) => (
    name?.startsWith(LEGACY_CHAT_DATABASE_PREFIX)
      ? [deleteIndexedDb(name)]
      : []
  )))
  if (!queryDeleted || chatResults.some((deleted) => !deleted)) return

  try {
    window.localStorage.setItem(LEGACY_CLEANUP_MARKER, "1")
  } catch {
    // A failed marker only repeats harmless best-effort cleanup next load.
  }
}

function memoryRuntime(reason: string): BrowserPersistenceRuntime {
  return {
    mode: "memory",
    persistence: null,
    reason,
    close: async () => {},
    sizeBytes: async () => null,
  }
}

async function sqliteSizeBytes(database: BrowserWASQLiteDatabase): Promise<number | null> {
  try {
    const [pageCount] = await database.execute<{ page_count: number }>("PRAGMA page_count")
    const [pageSize] = await database.execute<{ page_size: number }>("PRAGMA page_size")
    const [freePages] = await database.execute<{ freelist_count: number }>(
      "PRAGMA freelist_count",
    )
    if (!pageCount || !pageSize || !freePages) return null
    return Math.max(0, Number(pageCount.page_count) - Number(freePages.freelist_count))
      * Number(pageSize.page_size)
  } catch {
    return null
  }
}

async function createRuntime(): Promise<BrowserPersistenceRuntime> {
  void cleanupLegacyDatabases()
  const failure = capabilityFailure()
  if (failure) return memoryRuntime(failure)

  let database: BrowserWASQLiteDatabase | null = null
  let coordinator: BrowserCollectionCoordinator | null = null
  try {
    database = await openBrowserWASQLiteOPFSDatabase({ databaseName: DATABASE_NAME })
    coordinator = new BrowserCollectionCoordinator({ dbName: COORDINATOR_NAME })
    const persistence = createBrowserWASQLitePersistence({
      database,
      coordinator,
      schemaMismatchPolicy: "reset",
    })
    return {
      mode: "persistent",
      persistence,
      reason: null,
      close: async () => {
        coordinator?.dispose()
        coordinator = null
        await database?.close?.()
        database = null
      },
      sizeBytes: () => database ? sqliteSizeBytes(database) : Promise.resolve(null),
    }
  } catch (error) {
    coordinator?.dispose()
    await Promise.resolve(database?.close?.()).catch(() => {})
    const reason = error instanceof Error ? error.message : "OPFS initialization failed"
    console.warn(`[Alook persistence] Using memory-only collections: ${reason}`)
    return memoryRuntime(reason)
  }
}

export function getBrowserPersistenceRuntime(): Promise<BrowserPersistenceRuntime> {
  const global = persistenceGlobal()
  global.__alookBrowserPersistenceV1 ??= createRuntime()
  return global.__alookBrowserPersistenceV1
}

export function registerPersistenceClearScope(
  key: string,
  clear: () => Promise<void>,
): () => void {
  const entry = { clear, key }
  clearScopes().set(key, entry)
  return () => {
    if (clearScopes().get(key) === entry) clearScopes().delete(key)
  }
}

async function clearActivePersistedCaches(prefix?: string): Promise<void> {
  const entries = [...clearScopes().values()].filter(({ key }) => (
    !prefix || key.startsWith(prefix)
  ))
  await Promise.all(entries.map(({ clear }) => clear()))
}

export const clearAllPersistedCaches = clearActivePersistedCaches

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export async function getPersistedCacheSizeBytes(): Promise<number | null> {
  return (await getBrowserPersistenceRuntime()).sizeBytes()
}

export async function resetBrowserPersistenceForTests(): Promise<void> {
  const global = persistenceGlobal()
  const runtime = await global.__alookBrowserPersistenceV1?.catch(() => null)
  await runtime?.close()
  delete global.__alookBrowserPersistenceV1
  global.__alookPersistenceClearScopesV1?.clear()
}
