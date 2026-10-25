import { describe, expect, it } from "vitest"
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache"
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue"
import config from "../open-next.config"

function resolveOverride(value: unknown): unknown {
  return typeof value === "function" ? value() : value
}

describe("Web OpenNext configuration", () => {
  it("wraps the existing R2 store in regional caching and retains the Durable Object queue", () => {
    const cache = resolveOverride(config.default.override?.incrementalCache)
    expect(cache).toMatchObject({ store: r2IncrementalCache, opts: { mode: "long-lived" } })
    expect(resolveOverride(config.default.override?.queue)).toBe(doQueue)
    expect(resolveOverride(config.middleware?.override?.incrementalCache)).toBe(cache)
    expect(resolveOverride(config.middleware?.override?.queue)).toBe(doQueue)
  })

  it("intercepts prerendered responses without introducing a D1 tag cache", () => {
    expect(config.default.override?.tagCache).toBe("dummy")
    expect(config.middleware?.override?.tagCache).toBe("dummy")
    expect(config.default.override?.cdnInvalidation).toBe("dummy")
    expect(config.dangerous?.enableCacheInterception).toBe(true)
  })
})
