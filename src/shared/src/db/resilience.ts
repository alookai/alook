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
  // workerd / D1 transient runtime errors.
  "internal error; reference",
  "SQLITE_BUSY",
  "database is locked",
  "SQLITE_INTERRUPT",
  // CF RPC / fetch transient shapes. `fetch failed` covers Node's
  // fetch-rejection wrapper, `ETIMEDOUT` / `ECONNRESET` / `EAI_AGAIN`
  // catch DNS + socket transients seen from daemon-plane routes.
  "Network connection lost",
  // Durable-Object reset transients that D1 surfaces in PRODUCTION but never
  // in local miniflare, so they escape dev repro entirely. Copied VERBATIM
  // from Cloudflare's D1 `retry-queries` best-practices `isRetryableError`
  // list (case-sensitive `includes` — a single-char drift silently disables
  // the retry). `... code was updated` fires during OUR OWN deploys, so
  // without it every in-flight write during a deploy window 500s unretried.
  "storage caused object to be reset",
  "reset because its code was updated",
  "connection reset",
  "fetch failed",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  // `timeout after` catches Node's / undici's phrase; leading space on the
  // others avoids matching column names like `timeout_at` inside a
  // SQLITE_CONSTRAINT message.
  "timeout after",
  " timed out",
  "network timeout",
  "socket hang up",
]

/**
 * Peel a DrizzleQueryError chain to its underlying cause. If Drizzle ever
 * wraps a transient RPC error WITHOUT preserving `.cause` (older versions
 * of the ORM did this, and some codepaths still do), the bare wrapper's
 * message is `Failed query: …` — no signature matches, so classification
 * would silently return "not retryable" and every retry across the fleet
 * stops working. Return `null` in that case so the caller can conservatively
 * treat a bare DrizzleQueryError as retryable.
 */
function peelDrizzle(err: unknown): { peeled: unknown; bareWrapper: boolean } {
  if (!(err instanceof DrizzleQueryError)) return { peeled: err, bareWrapper: false }
  let cur: unknown = err
  while (cur instanceof DrizzleQueryError) {
    if (!cur.cause) return { peeled: cur, bareWrapper: true }
    cur = cur.cause
  }
  return { peeled: cur, bareWrapper: false }
}

export function isRetryableD1Error(err: unknown): boolean {
  const { peeled, bareWrapper } = peelDrizzle(err)
  // A DrizzleQueryError with no `.cause` is a database error whose transient
  // shape we can't inspect — retry conservatively rather than fail-fast.
  if (bareWrapper) return true
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
