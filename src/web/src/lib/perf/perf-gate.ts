/**
 * Single source of truth for whether local perf instrumentation is armed.
 *
 * Double-gated on purpose (see plans/community-switch-perf-diagnosis.md):
 * - `NEXT_PUBLIC_PERF_TRACE === "1"` — opt-in flag, off by default.
 * - `NODE_ENV !== "production"` — a hard backstop so a stray flag in a prod
 *   env can never arm the instrument or pull `react-scan` into a live build.
 *
 * `NEXT_PUBLIC_*` is inlined to a string literal by Next at build time, so in a
 * production bundle this collapses to `false` and every guarded body is
 * dead-code-eliminated.
 *
 * This is a function, not a module-level const, so unit tests can flip
 * `process.env` between cases and observe the gate.
 */
export function perfTraceEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_PERF_TRACE === "1" &&
    process.env.NODE_ENV !== "production"
  )
}
