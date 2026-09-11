import { describe, expect, it } from "vitest"
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache"
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue"
import config from "../open-next.config"

function resolveOverride(value: unknown): unknown {
  return typeof value === "function" ? value() : value
}

describe("Web OpenNext configuration", () => {
  it("uses the existing R2 cache and Durable Object revalidation queue", () => {
    expect(resolveOverride(config.default.override?.incrementalCache)).toBe(r2IncrementalCache)
    expect(resolveOverride(config.default.override?.queue)).toBe(doQueue)
    expect(resolveOverride(config.middleware?.override?.incrementalCache)).toBe(r2IncrementalCache)
    expect(resolveOverride(config.middleware?.override?.queue)).toBe(doQueue)
  })

  it("does not enable D1 tag cache or cache experiments", () => {
    expect(config.default.override?.tagCache).toBe("dummy")
    expect(config.middleware?.override?.tagCache).toBe("dummy")
    expect(config.default.override?.cdnInvalidation).toBe("dummy")
    expect(config.dangerous?.enableCacheInterception).toBe(false)
  })
})
