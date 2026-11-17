import { createHash } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { CachedFetchValue } from "next/dist/server/response-cache"
import { DOWNLOAD_TARGETS } from "./download-platforms"
import { RELEASE_CACHE_SECONDS } from "./github-releases"

await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks")
  vi.stubGlobal("AsyncLocalStorage", AsyncLocalStorage)
})

const { readCachedDownloadCatalog } = await import("./download-catalog-cache")

const entries = new Map<string, CachedFetchValue>()
let stale = false
const cacheGet = vi.fn(async (key: string) => {
  const value = entries.get(key)
  return value ? { value, isStale: stale } : null
})
const cacheSet = vi.fn(async (key: string, value: CachedFetchValue) => { entries.set(key, structuredClone(value)) })

function response(version = "1.0.0") {
  const names = ["latest.json", ...DOWNLOAD_TARGETS.map(target => target.id === "linux-rpm"
    ? `Alook-${version}-1.x86_64.rpm` : `Alook_${version}${target.suffix}`)]
  return new Response(JSON.stringify([{
    tag_name: `v${version}`, draft: false, prerelease: false,
    body: "Full provider metadata that must not enter the compact catalog",
    assets: names.map(name => ({ name, size: 1000, state: "uploaded", browser_download_url: `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(name)}` })),
  }]))
}

beforeEach(() => {
  entries.clear()
  stale = false
  cacheGet.mockClear()
  cacheSet.mockClear()
  vi.stubGlobal("__incrementalCache", {
    generateSimpleCacheKey: async (key: string) => createHash("sha256").update(key).digest("hex"),
    get: cacheGet,
    set: cacheSet,
  })
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("reuses the real Next Data Cache result without rereading provider metadata", async () => {
  const fetch = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal("fetch", fetch)
  const first = await readCachedDownloadCatalog()
  expect(first.installers).toHaveLength(8)
  expect(await readCachedDownloadCatalog()).toEqual(first)
  expect(fetch).toHaveBeenCalledTimes(1)
  const cached = [...entries.values()]
  expect(cached).toHaveLength(1)
  expect(cached[0].revalidate).toBe(RELEASE_CACHE_SECONDS)
  expect(JSON.parse(cached[0].data.body)).toEqual(first)
  expect(cached[0].data.body).not.toContain("Full provider metadata")
})

it("does not cache a failed source read and recovers on the next request", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockImplementation(async () => response())
  vi.stubGlobal("fetch", fetch)
  expect(await readCachedDownloadCatalog()).toEqual({ installers: [], unavailable: true })
  expect(entries.size).toBe(0)
  expect((await readCachedDownloadCatalog()).installers).toHaveLength(8)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(cacheSet).toHaveBeenCalledTimes(1)
})

it("refreshes stale installer data through Next's actual cache wrapper", async () => {
  let version = "1.0.0"
  const fetch = vi.fn().mockImplementation(async () => response(version))
  vi.stubGlobal("fetch", fetch)
  expect((await readCachedDownloadCatalog()).installers.every(item => item.version === version)).toBe(true)
  version = "1.0.1"
  stale = true
  expect((await readCachedDownloadCatalog()).installers.every(item => item.version === version)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(cacheGet).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ revalidate: 300 }))
})

it("keeps valid downloads available when the cache backend fails", async () => {
  cacheGet.mockRejectedValueOnce(new Error("private cache backend detail"))
  const fetch = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal("fetch", fetch)
  expect((await readCachedDownloadCatalog()).installers).toHaveLength(8)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(console.warn).toHaveBeenCalledWith("download_catalog_cache_unavailable")
})
