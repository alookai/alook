import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DrizzleQueryError } from "drizzle-orm/errors"
import {
  withD1Retry,
  readOrStale,
  isRetryableD1Error,
  idempotentWrite,
  nonIdempotentWriteAllowed,
} from "../src/db/resilience"
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

  it("retries Durable-Object reset transients using Cloudflare's VERBATIM doc strings", () => {
    // These sentences are copied character-for-character from Cloudflare's D1
    // `retry-queries` best-practices `isRetryableError` list. The matcher is a
    // case-sensitive `includes`, so a single-char drift between source and
    // doc silently disables the retry — asserting the doc's literal wording
    // here catches that drift instead of it only surfacing in a prod deploy
    // window (these never occur in local miniflare, so dev repro can't).
    const storageReset =
      "Error: Durable Object storage caused object to be reset; retry the request."
    const codeUpdated =
      "Error: the Durable Object was reset because its code was updated; retry the request."
    expect(isRetryableD1Error(new DrizzleQueryError("q", [], new Error(storageReset)))).toBe(true)
    expect(isRetryableD1Error(new DrizzleQueryError("q", [], new Error(codeUpdated)))).toBe(true)
  })

  it("does NOT match a non-transient message that merely contains the word 'reset'", () => {
    // Guards the two DO-reset substrings against over-breadth: a plain SQL
    // error mentioning "reset" (e.g. a column named `password_reset_at`) is a
    // logic error, not a transient — must NOT be retried.
    const err = new DrizzleQueryError(
      "INSERT",
      [],
      new Error("SQLITE_CONSTRAINT_NOTNULL: NOT NULL constraint failed: users.password_reset_at"),
    )
    expect(isRetryableD1Error(err)).toBe(false)
  })

  it("retries fetch/socket-level transients daemon-plane routes see", () => {
    for (const sig of [
      "fetch failed",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "request timeout after 5000ms",
      "socket hang up",
    ]) {
      expect(isRetryableD1Error(new DrizzleQueryError("q", [], new Error(sig)))).toBe(true)
    }
  })

  it("does NOT match column names containing 'timeout' in a SQLITE_CONSTRAINT message", () => {
    // Guard the tightened matcher — bare `timeout` used to match here.
    const err = new DrizzleQueryError(
      "INSERT",
      [],
      new Error("SQLITE_CONSTRAINT_NOTNULL: NOT NULL constraint failed: session.timeout_at"),
    )
    expect(isRetryableD1Error(err)).toBe(false)
  })

  it("conservatively retries a bare DrizzleQueryError with no .cause", () => {
    // Older Drizzle versions (and some codepaths in current ones) wrap a
    // transient RPC error without preserving `.cause` — the wrapper's
    // message is `Failed query: …` with no signature. Treat as retryable
    // rather than fail-fast.
    class BareDQE extends DrizzleQueryError {
      constructor() {
        super("SELECT 1", [], undefined as unknown as Error)
        // @ts-expect-error — deliberately null out cause to simulate the
        // bare-wrapper shape.
        this.cause = undefined
      }
    }
    expect(isRetryableD1Error(new BareDQE())).toBe(true)
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

describe("idempotentWrite (state 4a carrier)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("retries the transient whitelist (idempotent write is safe to re-run)", async () => {
    const fn = vi.fn(mockD1FailingUntil(2, "ok", { errorSignature: "sqlite_busy" }))
    const p = idempotentWrite({ dedupeKey: "srv:abc" }, fn)
    await vi.runAllTimersAsync()
    expect(await p).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("does NOT retry a non-retryable (logic) error", async () => {
    const fn = vi.fn().mockRejectedValue(makeD1Error("sqlite_constraint"))
    await expect(idempotentWrite({ dedupeKey: "srv:abc" }, fn)).rejects.toBeInstanceOf(
      DrizzleQueryError,
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("requires a dedupeKey at compile time", () => {
    // @ts-expect-error — dedupeKey is mandatory: an append-only write may not be
    // armored without proving it has a dedup identity.
    void idempotentWrite({}, async () => "x")
  })
})

describe("nonIdempotentWriteAllowed (state 4b carrier)", () => {
  it("does NOT retry — a non-idempotent write must not be auto-re-run on a transient", async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeD1Error("internal_error")).mockResolvedValue("ok")
    await expect(
      nonIdempotentWriteAllowed({ reason: "createServer — no dedup identity" }, fn),
    ).rejects.toBeInstanceOf(DrizzleQueryError)
    // One attempt only: the transient surfaces rather than risking a double-apply.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("passes through the value on success", async () => {
    const fn = vi.fn().mockResolvedValue("done")
    expect(await nonIdempotentWriteAllowed({ reason: "x" }, fn)).toBe("done")
  })

  it("requires a reason at compile time", () => {
    // @ts-expect-error — reason is mandatory: every retry exemption must be explicit.
    void nonIdempotentWriteAllowed({}, async () => "x")
  })
})
