import { DrizzleQueryError } from "drizzle-orm/errors"
import { createLogger, type Logger } from "../logger"

export type RetryOpts = {
  attempts?: number
  baseDelayMs?: number
  route?: string
}

type ReadOrStaleOpts = RetryOpts & { category?: string }

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 100

const defaultLogger: Logger = createLogger({ service: "d1-resilience" })

const RETRYABLE_SIGNATURES = [
  "internal error; reference",
  "SQLITE_BUSY",
  "database is locked",
  "SQLITE_INTERRUPT",
  "Network connection lost",
  "connection reset",
]

function peelDrizzle(err: unknown): unknown {
  let cur = err
  while (cur instanceof DrizzleQueryError) {
    if (!cur.cause) return cur
    cur = cur.cause
  }
  return cur
}

export function isRetryableD1Error(err: unknown): boolean {
  const peeled = peelDrizzle(err)
  if (!(peeled instanceof Error)) return false
  const msg = peeled.message
  if (typeof msg !== "string") return false
  for (const sig of RETRYABLE_SIGNATURES) {
    if (msg.includes(sig)) return true
  }
  return false
}

export async function withD1Retry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const route = opts.route
  let lastErr: unknown
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryableD1Error(err)) throw err
      if (i === attempts) break
      const cap = baseDelayMs * 2 ** i
      const delay = Math.floor(Math.random() * cap)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  defaultLogger.warn("d1_retry_exhausted", {
    category: "d1_retry_exhausted",
    route,
    err: lastErr instanceof Error ? lastErr : new Error(String(lastErr)),
  })
  throw lastErr
}

export async function readOrStale<T extends Record<string, unknown>>(
  fn: () => Promise<T>,
  fallback: T,
  opts: ReadOrStaleOpts = {},
): Promise<{ value: T; stale: boolean }> {
  try {
    const value = await withD1Retry(fn, opts)
    return { value, stale: false }
  } catch (err) {
    // Only launder RETRYABLE-shaped failures into `stale`. Non-retryable
    // throws (SQLITE_CONSTRAINT, TypeError from a broken query, ZodError…)
    // are real bugs — surfacing them as `d1_fail_closed` hides them behind
    // an outage-shaped log category and lets the UI render a false-empty
    // state. Rethrow so the route returns 500 and the bug is visible.
    if (!isRetryableD1Error(err)) throw err
    defaultLogger.warn("d1_fail_closed", {
      category: opts.category ?? "d1_fail_closed",
      route: opts.route,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return { value: fallback, stale: true }
  }
}
