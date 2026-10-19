// @vitest-environment jsdom
import * as fakeIndexedDB from "fake-indexeddb"
import { openDB } from "idb"
import { CacheExpiration } from "serwist"
import { afterEach, describe, expect, it, vi } from "vitest"
import { publicWorkerCacheNames } from "./cache-identity"
import { clearOutdatedPublicWorkerCaches, clearPublicWorkerCaches, getPublicWorkerCacheSizeBytes } from "./public-cache-storage"

function fixture() {
  for (const [name, value] of Object.entries(fakeIndexedDB)) if (name.startsWith("IDB")) vi.stubGlobal(name, value)
  vi.stubGlobal("indexedDB", new fakeIndexedDB.IDBFactory())
  const response = new Response("你好")
  const entries = new Map(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"].map((name) => [name, new Map([["https://alook.test/file", response.clone()]])]))
  const storage = { keys: vi.fn(async () => [...entries.keys()]), delete: vi.fn(async (name: string) => entries.delete(name)),
    open: vi.fn(async (name: string) => ({ keys: async () => [...entries.get(name)?.keys() ?? []].map((url) => new Request(url)),
      match: async (request: Request) => entries.get(name)?.get(request.url)?.clone() })) }
  vi.stubGlobal("caches", storage)
  return { entries, storage }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function timestamp(name: string) {
  const expiration = new CacheExpiration(name, { maxAgeSeconds: 3600 })
  await expiration.updateTimestamp("https://alook.test/blog/example/hero.webp")
  return () => expiration.isURLExpired("https://alook.test/blog/example/hero.webp")
}

describe("owned public worker cache family", () => {
  it("keeps both existing worker names while sizing every version in the owned family", async () => {
    const { storage } = fixture()
    expect(publicWorkerCacheNames()).toEqual({ cacheId: "alook-public-v1", precache: "alook-public-precache-v1" })
    await expect(getPublicWorkerCacheSizeBytes()).resolves.toBe(18)
    expect(storage.open.mock.calls.map(([name]) => name)).toEqual(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime"])
  })

  it("clears arbitrary past/current/future owned names and leaves unrelated caches", async () => {
    const { entries, storage } = fixture()
    await clearPublicWorkerCaches()
    expect([...entries.keys()]).toEqual(["unrelated-cache"])
    expect(storage.delete).toHaveBeenCalledTimes(3)
    expect(storage.open).not.toHaveBeenCalled()
  })

  it("removes outdated custom names on activation and keeps current precache/runtime names", async () => {
    const { entries, storage } = fixture()
    entries.set("alook-public-v1-runtime-https://example.test/", new Map())
    entries.set("alook-public-v1", new Map())
    entries.set("alook-public-v10-runtime", new Map())
    await clearOutdatedPublicWorkerCaches()
    expect([...entries.keys()]).toEqual(["alook-public-precache-v1", "unrelated-cache", "alook-public-v1-runtime-https://example.test/", "alook-public-v1"])
    expect(storage.delete).toHaveBeenCalledTimes(3)
  })

  it("finishes other owned deletions before reporting a failed deletion", async () => {
    const { entries, storage } = fixture()
    let release!: () => void
    storage.delete.mockImplementation(async name => {
      if (name === "alook-public-precache-v0") throw new Error("old cache occupied")
      if (name === "alook-public-v99-runtime") await new Promise<void>(resolve => { release = resolve })
      return entries.delete(name)
    })
    let settled = false
    const clearing = clearPublicWorkerCaches().finally(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(release).toBeTypeOf("function")
    release()
    await expect(clearing).rejects.toThrow("old cache occupied")
    expect([...entries.keys()]).toEqual(["alook-public-precache-v0", "unrelated-cache"])
  })

  it("skips an entry removed during sizing without consuming another response", async () => {
    const { entries } = fixture()
    entries.get("alook-public-precache-v0")!.clear()
    await expect(getPublicWorkerCacheSizeBytes()).resolves.toBe(12)
  })

  it("has no public cache to clear when the browser has no CacheStorage API", async () => {
    vi.stubGlobal("caches", undefined)
    await expect(getPublicWorkerCacheSizeBytes()).resolves.toBe(0)
    await expect(clearPublicWorkerCaches()).resolves.toBeUndefined()
  })

  it("propagates enumeration and deletion failures instead of claiming a full clear", async () => {
    const { storage } = fixture()
    const unavailable = new Error("cache enumeration unavailable")
    storage.keys.mockRejectedValue(unavailable)
    await expect(getPublicWorkerCacheSizeBytes()).rejects.toBe(unavailable)
    await expect(clearPublicWorkerCaches()).rejects.toBe(unavailable)
    storage.keys.mockResolvedValue(["alook-public-precache-v1"])
    const failed = new Error("cache deletion failed")
    storage.delete.mockRejectedValue(failed)
    await expect(clearPublicWorkerCaches()).rejects.toBe(failed)
  })

  it("retires an aborted size result both before and after enumeration", async () => {
    const { storage } = fixture()
    const first = new AbortController()
    first.abort()
    await expect(getPublicWorkerCacheSizeBytes(first.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(storage.keys).not.toHaveBeenCalled()
    const second = new AbortController()
    storage.keys.mockImplementationOnce(async () => { second.abort(); return ["alook-public-precache-v1"] })
    await expect(getPublicWorkerCacheSizeBytes(second.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(storage.open).not.toHaveBeenCalled()
  })

  it("clears current and enumerated old runtime timestamps while preserving other metadata", async () => {
    const { entries } = fixture()
    const owned = ["alook-public-v1-blog-code", "alook-public-v1-blog-fonts", "alook-public-v1-blog-images", "alook-public-v0-blog-images"]
    for (const name of owned) entries.set(name, new Map())
    const removed = await Promise.all(owned.map(timestamp))
    const unrelated = await timestamp("another-worker-blog-images")
    const unknown = await timestamp("alook-public-v1-another-plugin")
    await clearPublicWorkerCaches()
    expect(await Promise.all(removed.map(expired => expired()))).toEqual([true, true, true, true])
    expect(await unrelated()).toBe(false)
    expect(await unknown()).toBe(false)
    expect([...entries.keys()]).toEqual(["unrelated-cache"])
  })

  it("clears current orphan timestamps even when their Cache Storage entries are absent", async () => {
    const { entries } = fixture()
    entries.clear()
    const expired = await timestamp("alook-public-v1-blog-code")
    await clearPublicWorkerCaches()
    expect(await expired()).toBe(true)
    expect([...entries.keys()]).toEqual([])
  })

  it("keeps current runtime caches and timestamps on activation while removing an old version", async () => {
    const { entries } = fixture()
    const currentNames = ["alook-public-v1-blog-code", "alook-public-v1-blog-fonts", "alook-public-v1-blog-images"]
    const oldNames = ["alook-public-v0-blog-code", "alook-public-v0-blog-fonts", "alook-public-v0-blog-images"]
    for (const name of [...currentNames, ...oldNames]) entries.set(name, new Map())
    const current = await Promise.all(currentNames.map(timestamp))
    const old = await Promise.all(oldNames.map(timestamp))
    const unrelated = await timestamp("another-worker-blog-images")
    await clearOutdatedPublicWorkerCaches()
    expect(await Promise.all(current.map(expired => expired()))).toEqual([false, false, false])
    expect(await Promise.all(old.map(expired => expired()))).toEqual([true, true, true])
    expect(await unrelated()).toBe(false)
    for (const name of currentNames) expect(entries.has(name)).toBe(true)
    for (const name of oldNames) expect(entries.has(name)).toBe(false)
  })

  it("can repeat clearing with missing caches and missing timestamps without deleting the shared metadata DB", async () => {
    const { entries } = fixture()
    entries.clear()
    const unrelated = await timestamp("another-worker-blog-images")
    const deleteDatabase = vi.spyOn(indexedDB, "deleteDatabase")
    await clearPublicWorkerCaches()
    await clearPublicWorkerCaches()
    expect(await unrelated()).toBe(false)
    expect(deleteDatabase).not.toHaveBeenCalled()
    expect(entries.size).toBe(0)
  })

  it("finishes cache and other metadata deletions before reporting a metadata API error", async () => {
    const { entries } = fixture()
    const other = await timestamp("alook-public-v1-blog-images")
    const failed = new Error("timestamp storage unavailable")
    vi.spyOn(CacheExpiration.prototype, "delete").mockRejectedValueOnce(failed)
    await expect(clearPublicWorkerCaches()).rejects.toBe(failed)
    expect(await other()).toBe(true)
    expect([...entries.keys()]).toEqual(["unrelated-cache"])
  })

  it("still clears metadata when a Cache Storage deletion fails", async () => {
    const { storage } = fixture()
    const expired = await timestamp("alook-public-v1-blog-code")
    const failed = new Error("cache deletion unavailable")
    storage.delete.mockRejectedValueOnce(failed)
    await expect(clearPublicWorkerCaches()).rejects.toBe(failed)
    expect(await expired()).toBe(true)
  })

  it("propagates IndexedDB open failure after finishing the Cache Storage deletions", async () => {
    const { entries } = fixture()
    const failed = new Error("IndexedDB access denied")
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw failed })
    await expect(clearPublicWorkerCaches()).rejects.toBe(failed)
    expect([...entries.keys()]).toEqual(["unrelated-cache"])
  })

  it("does not change business IndexedDB contents while clearing public runtime metadata", async () => {
    fixture()
    const business = await openDB("keyval-store", 1, { upgrade(db) { db.createObjectStore("keyval") } })
    try {
      await business.put("keyval", { account: "fixture-only", schema: 6 }, "alook:qc:cache")
      const expired = await timestamp("alook-public-v1-blog-fonts")
      await clearPublicWorkerCaches()
      expect(await expired()).toBe(true)
      expect(await business.get("keyval", "alook:qc:cache")).toEqual({ account: "fixture-only", schema: 6 })
    } finally { business.close() }
  })
})
