import { DrizzleQueryError } from "drizzle-orm/errors"

export type ErrorSignature =
  | "internal_error"
  | "sqlite_busy"
  | "sqlite_constraint"
  | "unknown"

const SIGNATURE_MESSAGES: Record<ErrorSignature, string> = {
  internal_error: "internal error; reference = 0123abcd",
  sqlite_busy: 'D1_ERROR: near "SELECT": SQLITE_BUSY: database is locked',
  sqlite_constraint: "D1_ERROR: SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed",
  unknown: "something went wrong",
}

export function makeD1Error(signature: ErrorSignature = "internal_error"): DrizzleQueryError {
  return new DrizzleQueryError("SELECT 1", [], new Error(SIGNATURE_MESSAGES[signature]))
}

/**
 * Test-fixture: returns an async fn that throws a DrizzleQueryError-shaped
 * error for the first `n` invocations, then resolves with `value`.
 *
 * Every integration test in `plans/d1-critical-path-resilience-v2.md` uses
 * this helper — DO NOT replace with `withD1Retry: vi.fn((fn) => fn())`
 * passthrough mocks. The passthrough pattern used by daemon-plane tests is
 * fine there (they DON'T test retry semantics); this plan's new tests DO,
 * so they need the real retry path, injected at the query-fn level.
 */
export function mockD1FailingUntil<T>(
  n: number,
  value: T,
  opts?: { errorSignature?: ErrorSignature },
): () => Promise<T> {
  const signature = opts?.errorSignature ?? "internal_error"
  let calls = 0
  return async () => {
    if (calls < n) {
      calls++
      throw makeD1Error(signature)
    }
    return value
  }
}
