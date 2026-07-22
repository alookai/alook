import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DrizzleQueryError } from "drizzle-orm/errors"
import { withD1Retry, readOrStale, isRetryableD1Error } from "../src/db/resilience"
import { mockD1FailingUntil, makeD1Error } from "../src/db/resilience-testing"

describe("withD1Retry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("succeeds on first attempt — no retry, no delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    const promise = withD1Retry(fn)
    await vi.runAllTimersAsync()
    expect(await promise).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("succeeds on 2nd attempt after one transient failure", async () => {
    const fn = mockD1FailingUntil(1, "ok")
    const promise = withD1Retry(fn)
    await vi.runAllTimersAsync()
    expect(await promise).toBe("ok")
  })

  it("succeeds on 3rd attempt after two transient failures", async () => {
    const fn = mockD1FailingUntil(2, "ok")
    const promise = withD1Retry(fn)
    await vi.runAllTimersAsync()
    expect(await promise).toBe("ok")
  })

  it("full-jitter delays fall in [0, base * 2^i]", async () => {
    // Sample the delay distribution by capturing setTimeout durations.
    // Success-on-4th-call so each call chain sleeps exactly 3 times, and no
    // final unhandled rejection leaks (unlike an all-fail path).
    const durations: number[] = []
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      // @ts-expect-error — narrow the mock; we only care about the delay arg.
      .mockImplementation((cb: () => void, ms?: number) => {
        durations.push(ms ?? 0)
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      })
    try {
      for (let i = 0; i < 200; i++) {
        await withD1Retry(mockD1FailingUntil(3, "ok"), { attempts: 3 })
      }
    } finally {
      setTimeoutSpy.mockRestore()
    }
    // Attempt 0 delay ∈ [0, 100), attempt 1 ∈ [0, 200), attempt 2 ∈ [0, 400).
    // Bucket per position modulo 3 (there are 3 sleeps per failing chain).
    const buckets: number[][] = [[], [], []]
    for (let i = 0; i < durations.length; i++) buckets[i % 3].push(durations[i])
    expect(Math.max(...buckets[0])).toBeLessThan(100)
    expect(Math.max(...buckets[1])).toBeLessThan(200)
    expect(Math.max(...buckets[2])).toBeLessThan(400)
    // Mean roughly cap/2 — assert distribution mean sits below 0.75 * cap
    // (not clustered at the cap ceiling, which would signal a non-jittered
    // implementation).
    const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(meanOf(buckets[0])).toBeLessThan(75)
    expect(meanOf(buckets[1])).toBeLessThan(150)
    expect(meanOf(buckets[2])).toBeLessThan(300)
  })

  it("retry-exhaust throws the last error and logs d1_retry_exhausted", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const fn = mockD1FailingUntil(999, "unused")
    const promise = withD1Retry(fn, { attempts: 3, route: "test-route" }).catch((e) => e)
    await vi.runAllTimersAsync()
    const caught = await promise
    expect(caught).toBeInstanceOf(DrizzleQueryError)
    const logged = logSpy.mock.calls.flat().join(" ")
    expect(logged).toContain("d1_retry_exhausted")
    expect(logged).toContain("test-route")
  })
})

describe("classifier — isRetryableD1Error", () => {
  it("retries workerd internal error wrapped in DrizzleQueryError", () => {
    const err = new DrizzleQueryError("SELECT 1", [], new Error("internal error; reference = abc"))
    expect(isRetryableD1Error(err)).toBe(true)
  })

  it("retries SQLITE_BUSY wrapped in DrizzleQueryError with realistic message", () => {
    const err = new DrizzleQueryError("SELECT ...", [], new Error('D1_ERROR: near "SELECT": SQLITE_BUSY: database is locked'))
    expect(isRetryableD1Error(err)).toBe(true)
  })

  it("does NOT retry SQLITE_CONSTRAINT_UNIQUE", () => {
    const err = new DrizzleQueryError("INSERT", [], new Error("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed"))
    expect(isRetryableD1Error(err)).toBe(false)
  })

  it("does NOT retry a Zod parse error", () => {
    const err = new Error("[{\"code\":\"invalid_type\"}]")
    err.name = "ZodError"
    expect(isRetryableD1Error(err)).toBe(false)
  })

  it("does NOT retry an unknown error shape (deny-by-default)", () => {
    expect(isRetryableD1Error(new Error("something exploded"))).toBe(false)
  })

  it("peels double-wrapped DrizzleQueryError", () => {
    const inner = new DrizzleQueryError("q1", [], new Error("internal error; reference = z"))
    const outer = new DrizzleQueryError("q2", [], inner)
    expect(isRetryableD1Error(outer)).toBe(true)
  })

  it("retries SQLITE_INTERRUPT", () => {
    const err = new DrizzleQueryError("q", [], new Error("D1_ERROR: SQLITE_INTERRUPT"))
    expect(isRetryableD1Error(err)).toBe(true)
  })

  it("retries Network connection lost / CF RPC transient", () => {
    expect(isRetryableD1Error(new DrizzleQueryError("q", [], new Error("Network connection lost")))).toBe(true)
    expect(isRetryableD1Error(new DrizzleQueryError("q", [], new Error("connection reset by peer")))).toBe(true)
  })
})

describe("readOrStale", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("returns { value, stale: false } on success", async () => {
    const promise = readOrStale(async () => ({ online: ["a"] }), { online: [] })
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toEqual({ value: { online: ["a"] }, stale: false })
  })

  it("returns { value: fallback, stale: true } on retry-exhaust and logs d1_fail_closed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const fn = mockD1FailingUntil(999, { online: [] })
    const promise = readOrStale(fn, { online: [] as string[] }, { route: "test", category: "d1_fail_closed" })
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toEqual({ value: { online: [] }, stale: true })
    const logged = logSpy.mock.calls.flat().join(" ")
    expect(logged).toContain("d1_fail_closed")
  })



  it("re-throws non-retryable errors instead of laundering them as stale", async () => {
    // A real bug (constraint violation, TypeError from a broken query, …)
    // must NOT be hidden behind `stale: true` — the route should 500 so the
    // bug surfaces in error observability instead of masquerading as a D1
    // outage log line + empty UI.
    const promise = readOrStale(
      async () => {
        throw new Error("SQLITE_CONSTRAINT_UNIQUE: whatever")
      },
      { rows: [] as unknown[] },
    ).catch((e) => e)
    await vi.runAllTimersAsync()
    const err = await promise
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("SQLITE_CONSTRAINT_UNIQUE")
  })
})

describe("mockD1FailingUntil helper", () => {
  it("throws DrizzleQueryError-shaped errors N times, then returns value", async () => {
    const fn = mockD1FailingUntil(2, "done")
    await expect(fn()).rejects.toBeInstanceOf(DrizzleQueryError)
    await expect(fn()).rejects.toBeInstanceOf(DrizzleQueryError)
    expect(await fn()).toBe("done")
  })

  it("supports errorSignature override", async () => {
    const fn = mockD1FailingUntil(1, "x", { errorSignature: "sqlite_constraint" })
    try {
      await fn()
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(DrizzleQueryError)
      expect(((e as DrizzleQueryError).cause as Error).message).toContain("SQLITE_CONSTRAINT")
    }
  })

  it("makeD1Error produces a matching DrizzleQueryError", () => {
    const err = makeD1Error("internal_error")
    expect(err).toBeInstanceOf(DrizzleQueryError)
    expect((err.cause as Error).message).toContain("internal error; reference")
  })
})

describe("readOrStale — TypeScript compile-time constraint", () => {
  it("rejects array T at compile time", () => {
    // @ts-expect-error — T must extend Record<string, unknown>; arrays are not allowed.
    void readOrStale<unknown[]>(async () => [], [])
  })
})
