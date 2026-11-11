import type { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache"

type Cache = Parameters<typeof withRegionalCache>[0]
type ReadResult = "entry" | "null" | "error"

export const RELEASE_CATALOG_FETCH_KEY = "ad8b89d4b1f364616e0d4615da0527e5516396af0d29c5677e7d12ee9f4dd948"

function property(record: unknown, key: string): { present: boolean; value: unknown } {
  if (record === null || typeof record !== "object") return { present: false, value: undefined }
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return { present: descriptor !== undefined, value: descriptor && "value" in descriptor ? descriptor.value : undefined }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function recordRead(entry: unknown, result: ReadResult) {
  try {
    const value = property(entry, "value").value
    const kind = property(value, "kind")
    const modified = property(entry, "lastModified")
    const revalidate = property(value, "revalidate")
    const status = property(property(value, "data").value, "status")
    const wallNow = Date.now()
    const timeOrigin = performance.timeOrigin
    const performanceNow = performance.now()
    const frameworkNow = finite(timeOrigin) && finite(performanceNow) ? timeOrigin + performanceNow : null
    const wallAge = finite(wallNow) && finite(modified.value) ? wallNow - modified.value : null
    const frameworkAge = finite(frameworkNow) && finite(modified.value) ? frameworkNow - modified.value : null
    const build = process.env.OPEN_NEXT_BUILD_ID
    const buildAvailable = typeof build === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(build)
    const revalidateValid = revalidate.value === false || finite(revalidate.value)
    const statusValid = finite(status.value) && Number.isInteger(status.value) && status.value >= 0 && status.value <= 599

    console.info("download_catalog_cache_read", {
      schema_version: 1,
      cache_type: "fetch",
      fetch_key: RELEASE_CATALOG_FETCH_KEY,
      build_id: buildAvailable ? build : null,
      build_id_state: buildAvailable ? "available" : "unavailable",
      read_result: result,
      value_kind: kind.value === "FETCH" ? "FETCH" : kind.present ? "other" : "unavailable",
      last_modified_present: modified.present,
      last_modified_valid: finite(modified.value),
      last_modified_ms: finite(modified.value) ? modified.value : null,
      revalidate_present: revalidate.present,
      revalidate_valid: revalidateValid,
      revalidate_seconds: revalidateValid ? revalidate.value : null,
      status_present: status.present,
      status_valid: statusValid,
      status: statusValid ? status.value : null,
      wall_now_ms: finite(wallNow) ? wallNow : null,
      performance_time_origin_ms: finite(timeOrigin) ? timeOrigin : null,
      performance_now_ms: finite(performanceNow) ? performanceNow : null,
      framework_now_ms: finite(frameworkNow) ? frameworkNow : null,
      wall_observed_age_ms: finite(wallAge) ? wallAge : null,
      framework_observed_age_ms: finite(frameworkAge) ? frameworkAge : null,
    })
  } catch {}
}

export function observeDownloadCacheReads<T extends Cache>(cache: T): T {
  const get: Cache["get"] = cache.get.bind(cache)
  cache.get = async (...args) => {
    const [key, cacheType] = args
    const targeted = key === RELEASE_CATALOG_FETCH_KEY && cacheType === "fetch"
    try {
      const entry = await get(...args)
      if (targeted) recordRead(entry, entry === null ? "null" : "entry")
      return entry
    } catch (error) {
      if (targeted) recordRead(undefined, "error")
      throw error
    }
  }
  return cache
}
