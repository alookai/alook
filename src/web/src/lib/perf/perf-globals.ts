import type { LiteEvent } from "react-scan/lite"

/**
 * Shape of a single captured perf event pushed onto the ring buffer. A trimmed
 * projection of react-scan's `LiteEvent` plus a wall-clock-free monotonic `ts`
 * (browser `performance.now()`), so everything the report correlates —
 * commits, unmounts, switch marks, resource timings — shares one clock.
 */
export interface PerfEventRecord {
  kind: LiteEvent["kind"]
  /** performance.now() at capture time (browser monotonic clock). */
  ts: number
  /** commit priority name, when present. */
  priorityName?: string
  /** true when react-dom flagged a commit error. */
  didError?: boolean
  /** per-fiber summaries for `commit` events (already trimmed by react-scan). */
  fibers?: PerfFiberRecord[]
  /** componentName on per-component mark events / fiber-unmount. */
  componentName?: string
  /** profiling-hooks-status availability. */
  available?: boolean
}

export interface PerfFiberRecord {
  name: string
  depth: number
  fiberId?: number
  actualDuration: number
  ownerName?: string | null
  /** null for host nodes; carries the re-render reason otherwise. */
  isFirstMount?: boolean
  changedProps?: string[] | null
  changedState?: boolean
  changedContext?: boolean
  changedHooks?: number[]
  changedByParent?: boolean
}

/** A switch anchor (`t=0`) recorded at the click site. */
export interface PerfSwitchMark {
  kind: "server" | "channel"
  id: string
  ts: number
  markName: string
}

declare global {
  interface Window {
    /** Bounded ring buffer of captured render/commit events. */
    __ALOOK_PERF__?: PerfEventRecord[]
    /** Switch-click anchors, in click order. */
    __ALOOK_PERF_MARKS__?: PerfSwitchMark[]
    /** Set true if react-scan's profiling hooks are unavailable. */
    __ALOOK_PERF_DEGRADED__?: boolean
    /** Set once when instrument() has been installed, to guard double-install. */
    __ALOOK_PERF_INSTALLED__?: boolean
  }
}

/** Max events retained; oldest are dropped so a long session can't OOM the tab. */
export const PERF_RING_MAX = 5000

/**
 * Push an event onto the ring buffer, allocating it on first use and clamping
 * to `PERF_RING_MAX` (drop-oldest). Kept pure/DOM-free so it unit-tests against
 * a plain object standing in for `window`.
 */
export function pushPerfEvent(
  target: { __ALOOK_PERF__?: PerfEventRecord[] },
  record: PerfEventRecord,
  max: number = PERF_RING_MAX,
): void {
  const buf = target.__ALOOK_PERF__ ?? (target.__ALOOK_PERF__ = [])
  buf.push(record)
  if (buf.length > max) buf.splice(0, buf.length - max)
}
