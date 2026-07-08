import { describe, it, expect, vi, beforeEach } from "vitest"
import { checkMessageRateLimit } from "./rate-limit"

function makeKv() {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    _store: store,
  }
}

describe("checkMessageRateLimit", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("allows the first request for a user with no prior state", async () => {
    const kv = makeKv()
    const result = await checkMessageRateLimit(kv as any, "user-1")
    expect(result.allowed).toBe(true)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it("allows up to the configured max within a window", async () => {
    const kv = makeKv()
    for (let i = 0; i < 30; i++) {
      const result = await checkMessageRateLimit(kv as any, "user-1")
      expect(result.allowed).toBe(true)
    }
  })

  it("rejects the request past the configured max within the same window", async () => {
    const kv = makeKv()
    for (let i = 0; i < 30; i++) {
      await checkMessageRateLimit(kv as any, "user-1")
    }
    const result = await checkMessageRateLimit(kv as any, "user-1")
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfterSec).toBeGreaterThan(0)
    }
  })

  it("does not block a different user sharing the same KV store", async () => {
    const kv = makeKv()
    for (let i = 0; i < 30; i++) {
      await checkMessageRateLimit(kv as any, "user-1")
    }
    const blocked = await checkMessageRateLimit(kv as any, "user-1")
    expect(blocked.allowed).toBe(false)

    const other = await checkMessageRateLimit(kv as any, "user-2")
    expect(other.allowed).toBe(true)
  })

  it("allows again once the window has elapsed", async () => {
    const kv = makeKv()
    const nowSpy = vi.spyOn(Date, "now")
    let currentTime = 1_000_000
    nowSpy.mockImplementation(() => currentTime)

    for (let i = 0; i < 30; i++) {
      await checkMessageRateLimit(kv as any, "user-1")
    }
    const blocked = await checkMessageRateLimit(kv as any, "user-1")
    expect(blocked.allowed).toBe(false)

    // Advance past the 10s window.
    currentTime += 10_001
    const allowedAgain = await checkMessageRateLimit(kv as any, "user-1")
    expect(allowedAgain.allowed).toBe(true)

    nowSpy.mockRestore()
  })
})
