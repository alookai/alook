import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IncrementalCache } from "next/dist/server/lib/incremental-cache"
import { fetchGitHubReleases } from "./github-releases"
import { observeDownloadCacheReads, RELEASE_CATALOG_FETCH_KEY } from "./download-cache-read-observation"

type Cache = Parameters<typeof observeDownloadCacheReads>[0]

const entry = {
  lastModified: 1000,
  value: { kind: "FETCH" as const, revalidate: 300, data: { status: 200, body: "private body", headers: {}, url: "private URL" } },
}

function backing() {
  return {
    name: "existing-cache",
    get: vi.fn<Cache["get"]>().mockResolvedValue(entry),
    set: vi.fn<Cache["set"]>().mockResolvedValue(undefined),
    delete: vi.fn<Cache["delete"]>().mockResolvedValue(undefined),
  } satisfies Cache
}

function readings() {
  return vi.mocked(console.info).mock.calls.map(([, value]) => value)
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {})
  vi.spyOn(Date, "now").mockReturnValue(5000)
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(2000)
  vi.spyOn(performance, "now").mockReturnValue(3500)
  vi.stubEnv("OPEN_NEXT_BUILD_ID", "local_build_319")
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("fixed catalog composite cache-read observation", () => {
  it("preserves the instance, receiver, one delegation, entry identity and remaining methods", async () => {
    const cache = backing()
    const set = cache.set, remove = cache.delete
    const observed = observeDownloadCacheReads(cache)
    expect(observed).toBe(cache)
    expect(await observed.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).toBe(entry)
    expect(observed.name).toBe("existing-cache")
    expect(observed.set).toBe(set)
    expect(observed.delete).toBe(remove)
    const read = readings()[0]
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(read).toMatchObject({ read_result: "entry", value_kind: "FETCH", last_modified_ms: 1000,
      revalidate_seconds: 300, status: 200, wall_now_ms: 5000, performance_time_origin_ms: 2000,
      performance_now_ms: 3500, framework_now_ms: 5500, wall_observed_age_ms: 4000, framework_observed_age_ms: 4500 })
    expect(JSON.stringify(read)).not.toContain("private")
  })

  it("passes the original get arguments and this exactly once", async () => {
    const cache = backing(), get = cache.get
    observeDownloadCacheReads(cache)
    await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")
    expect(get).toHaveBeenCalledExactlyOnceWith(RELEASE_CATALOG_FETCH_KEY, "fetch")
    expect(get.mock.contexts).toEqual([cache])
  })

  it("preserves omission of the optional cache type", async () => {
    const cache = backing(), get = cache.get
    observeDownloadCacheReads(cache)
    expect(await cache.get(RELEASE_CATALOG_FETCH_KEY)).toBe(entry)
    expect(get).toHaveBeenCalledExactlyOnceWith(RELEASE_CATALOG_FETCH_KEY)
    expect(console.info).not.toHaveBeenCalled()
  })

  it("keeps set/delete arguments, receiver and original promise", () => {
    const cache = backing(), set = cache.set, remove = cache.delete
    const setResult = Promise.resolve(), deleteResult = Promise.resolve()
    set.mockReturnValue(setResult); remove.mockReturnValue(deleteResult)
    observeDownloadCacheReads(cache)
    expect(cache.set(RELEASE_CATALOG_FETCH_KEY, entry.value, "fetch")).toBe(setResult)
    expect(cache.delete(RELEASE_CATALOG_FETCH_KEY)).toBe(deleteResult)
    expect(set).toHaveBeenCalledExactlyOnceWith(RELEASE_CATALOG_FETCH_KEY, entry.value, "fetch")
    expect(remove).toHaveBeenCalledExactlyOnceWith(RELEASE_CATALOG_FETCH_KEY)
    expect(set.mock.contexts).toEqual([cache]); expect(remove.mock.contexts).toEqual([cache])
    expect(console.info).not.toHaveBeenCalled()
  })

  it.each([
    ["another-key", "fetch" as const], [RELEASE_CATALOG_FETCH_KEY, "cache" as const],
    [RELEASE_CATALOG_FETCH_KEY, undefined],
    ["5736d41c9c0a61a1c724c0fb929caa8d025ccff8aac2e7c7a13925532cf2544e", "fetch" as const],
  ])("leaves a non-target read silent (%s, %s)", async (key, type) => {
    const cache = backing(), get = cache.get
    observeDownloadCacheReads(cache)
    expect(await cache.get(key, type)).toBe(entry)
    expect(get).toHaveBeenCalledExactlyOnceWith(key, type)
    expect(console.info).not.toHaveBeenCalled()
  })

  it("distinguishes a null read from absent or malformed entry metadata", async () => {
    const cache = backing(), get = cache.get
    get.mockResolvedValue(null)
    observeDownloadCacheReads(cache)
    expect(await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).toBeNull()
    expect(readings()[0]).toMatchObject({ read_result: "null", last_modified_present: false,
      last_modified_valid: false, last_modified_ms: null, revalidate_present: false, revalidate_seconds: null,
      status_present: false, status: null, wall_observed_age_ms: null, framework_observed_age_ms: null })
  })

  it("keeps valid zero/false metadata and negative observed ages", async () => {
    const cache = backing(), get = cache.get
    const future = { ...entry, lastModified: 6000, value: { ...entry.value, revalidate: false as const, data: { ...entry.value.data, status: 0 } } }
    get.mockResolvedValue(future)
    observeDownloadCacheReads(cache)
    expect(await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).toBe(future)
    expect(readings()[0]).toMatchObject({ last_modified_valid: true, revalidate_valid: true,
      revalidate_seconds: false, status_valid: true, status: 0, wall_observed_age_ms: -1000, framework_observed_age_ms: -500 })
  })

  it("does not replace a zero timestamp or zero revalidation interval", async () => {
    const cache = backing(), get = cache.get
    get.mockResolvedValue({ ...entry, lastModified: 0, value: { ...entry.value, revalidate: 0 } })
    observeDownloadCacheReads(cache)
    await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")
    expect(readings()[0]).toMatchObject({ last_modified_ms: 0, revalidate_seconds: 0,
      wall_observed_age_ms: 5000, framework_observed_age_ms: 5500 })
  })

  it("reports invalid values explicitly and never reads accessors or the body", async () => {
    const cache = backing(), get = cache.get
    const invalid = { ...entry, lastModified: NaN, value: { ...entry.value, revalidate: Infinity,
      data: { ...entry.value.data, status: -1 } } }
    const body = vi.fn(() => { throw new Error("private body getter") })
    const kind = vi.fn(() => "private kind")
    Object.defineProperty(invalid.value.data, "body", { get: body })
    Object.defineProperty(invalid.value, "kind", { get: kind })
    get.mockResolvedValue(invalid)
    observeDownloadCacheReads(cache)
    expect(await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).toBe(invalid)
    expect(body).not.toHaveBeenCalled(); expect(kind).not.toHaveBeenCalled()
    expect(readings()[0]).toMatchObject({ value_kind: "other", last_modified_present: true,
      last_modified_valid: false, last_modified_ms: null, revalidate_present: true, revalidate_valid: false,
      revalidate_seconds: null, status_valid: false, status: null, wall_observed_age_ms: null })
    expect(JSON.stringify(readings())).not.toContain("private")
  })

  it.each(["projection", "clock", "console"])("contains an observer %s failure", async failure => {
    const cache = backing(), get = cache.get
    const projected = new Proxy(entry, { getOwnPropertyDescriptor() { throw new Error("private projection") } })
    if (failure === "projection") get.mockResolvedValue(projected)
    if (failure === "clock") vi.mocked(Date.now).mockImplementation(() => { throw new Error("private clock") })
    if (failure === "console") vi.mocked(console.info).mockImplementation(() => { throw new Error("private logger") })
    observeDownloadCacheReads(cache)
    expect(await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).toBe(failure === "projection" ? projected : entry)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("preserves the original read error even if recording also fails", async () => {
    const cache = backing(), get = cache.get, error = new Error("private original error")
    get.mockRejectedValue(error)
    observeDownloadCacheReads(cache)
    await expect(cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).rejects.toBe(error)
    expect(readings()[0]).toMatchObject({ read_result: "error", last_modified_present: false })
    expect(JSON.stringify(readings())).not.toContain("private")
    vi.mocked(console.info).mockImplementation(() => { throw new Error("private logger") })
    await expect(cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")).rejects.toBe(error)
  })

  it("uses explicit unavailable build/clock readings rather than invented defaults", async () => {
    const cache = backing()
    vi.stubEnv("OPEN_NEXT_BUILD_ID", "invalid namespace with private text")
    vi.mocked(performance.now).mockReturnValue(Infinity)
    observeDownloadCacheReads(cache)
    await cache.get(RELEASE_CATALOG_FETCH_KEY, "fetch")
    expect(readings()[0]).toMatchObject({ build_id: null, build_id_state: "unavailable",
      performance_now_ms: null, framework_now_ms: null, framework_observed_age_ms: null, wall_observed_age_ms: 4000 })
    expect(JSON.stringify(readings())).not.toContain("private")
  })

  it("targets the actual source helper identity produced by the pinned Next generator", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("[]"))
    vi.stubGlobal("fetch", fetch)
    await fetchGitHubReleases()
    const [url, init] = fetch.mock.calls[0]!
    const generate = IncrementalCache.prototype.generateCacheKey
    expect(await generate.call({ fetchCacheKeyPrefix: "" }, String(url), init)).toBe(RELEASE_CATALOG_FETCH_KEY)
  })
})
