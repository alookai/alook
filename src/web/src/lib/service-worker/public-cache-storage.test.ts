import { afterEach, describe, expect, it, vi } from "vitest"
import { publicWorkerCacheNames } from "./cache-identity"
import { clearOutdatedPublicWorkerCaches, clearPublicWorkerCaches, getPublicWorkerCacheSizeBytes } from "./public-cache-storage"

function fixture() {
  const response = new Response("你好")
  const entries = new Map(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"].map((name) => [name, new Map([["https://alook.test/file", response.clone()]])]))
  const storage = { keys: vi.fn(async () => [...entries.keys()]), delete: vi.fn(async (name: string) => entries.delete(name)),
    open: vi.fn(async (name: string) => ({ keys: async () => [...entries.get(name)?.keys() ?? []].map((url) => new Request(url)),
      match: async (request: Request) => entries.get(name)?.get(request.url)?.clone() })) }
  vi.stubGlobal("caches", storage)
  return { entries, storage }
}

afterEach(() => vi.unstubAllGlobals())

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
})
