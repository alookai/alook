import { perfTraceEnabled } from "./perf-gate"
import type { PerfSwitchMark } from "./perf-globals"

/**
 * Record a `t=0` anchor at a server/channel switch click site. The Playwright
 * perf spec correlates the following network + render events against this mark
 * to compute perceived latency (see plans/community-switch-perf-diagnosis.md).
 *
 * Guarded no-op when the perf gate is off, so the two hot-path call sites
 * (`setActiveChannel`, `onRailServerNavigate`) add zero cost in real builds.
 */
export function markSwitch(kind: "server" | "channel", id: string): void {
  if (!perfTraceEnabled()) return
  if (typeof window === "undefined" || typeof performance === "undefined") return

  const markName = `alook:switch:${kind}:${id}`
  performance.mark(markName)

  const entry: PerfSwitchMark = { kind, id, ts: performance.now(), markName }
  const buf = window.__ALOOK_PERF_MARKS__ ?? (window.__ALOOK_PERF_MARKS__ = [])
  buf.push(entry)
}
