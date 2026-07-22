import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withD1Retry } from "./db"
import { mockD1FailingUntil, makeD1Error } from "@alook/shared/db/resilience-testing"

/**
 * Characterization test — pins the observable contract of `withD1Retry`
 * after the move from `src/web/src/lib/db.ts` to `src/shared/src/db/resilience.ts`.
 *
 * Pre-move behavior was: up to 3 retries after initial (4 total), fixed
 * delays 100/200/400ms, retry on ANY error. Post-move, the intentional
 * changes are (a) full-jitter delays bounded by the same caps and (b) an
 * allow-list classifier that peels DrizzleQueryError.cause and only retries
 * transient shapes. Daemon-plane callers pass Drizzle-wrapped D1 errors so
 * behavior is unchanged in practice; unknown Error shapes now fail-fast.
 */
describe("web/lib/db withD1Retry re-export", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("returns result on first success — no retry, no delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    const promise = withD1Retry(fn)
    await vi.runAllTimersAsync()
    expect(await promise).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on transient D1 failure then succeeds", async () => {
    const fn = mockD1FailingUntil(1, "recovered")
    const promise = withD1Retry(fn)
    await vi.runAllTimersAsync()
    expect(await promise).toBe("recovered")
  })

  it("throws after retries exhausted for persistent transient failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const fn = mockD1FailingUntil(999, "unused")
    const promise = withD1Retry(fn).catch((e) => e)
    await vi.runAllTimersAsync()
    const err = await promise
    expect(err).toBeDefined()
  })

  it("does NOT retry non-transient errors (allow-list, deny-by-default)", async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw makeD1Error("sqlite_constraint")
    }
    const promise = withD1Retry(fn).catch((e) => e)
    await vi.runAllTimersAsync()
    const err = await promise
    expect(err).toBeDefined()
    expect(calls).toBe(1)
  })

  it("respects custom attempts count via opts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    let calls = 0
    const fn = async () => {
      calls++
      throw makeD1Error("internal_error")
    }
    const promise = withD1Retry(fn, { attempts: 2 }).catch(() => {})
    await vi.runAllTimersAsync()
    await promise
    expect(calls).toBe(3)
  })
})
