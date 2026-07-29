// Shared schema between the Playwright perf spec (producer) and the report
// generator (consumer). All timestamps are the BROWSER monotonic clock
// (performance.now()) so network, marks, renders, and layout shifts correlate
// without cross-clock skew. See plans/community-switch-perf-diagnosis.md.

export type CacheState = "cold" | "memory-warm" | "disk-warm"
export type SwitchKind = "server" | "channel"

/** One `/api/community/*` request, from the in-page resource observer. */
export interface CapturedResource {
  name: string
  /** performance.now() at fetchStart. */
  startTime: number
  /** performance.now() at responseEnd. */
  responseEnd: number
}

/** One render commit, projected from the react-scan ring buffer. */
export interface CapturedCommit {
  ts: number
  kind: string
  /** fibers that mounted this commit (isFirstMount). */
  mounts: CapturedFiber[]
  /** fibers that re-rendered (not first mount). */
  rerenders: CapturedFiber[]
}

export interface CapturedFiber {
  name: string
  fiberId?: number
  actualDuration: number
  /** compact re-render reason, e.g. "props:[x]", "parent", "hooks". */
  reason?: string
}

/** A single switch, fully captured across one cache state. */
export interface CapturedSwitch {
  kind: SwitchKind
  targetId: string
  cacheState: CacheState
  /** performance.now() of the click mark (t=0). */
  clickTs: number
  /** performance.now() when the first skeleton for the target appeared. */
  skeletonTs: number | null
  /** performance.now() when the first message row painted. */
  paintedTs: number | null
  /** performance.now() of the last ResizeObserver settle on the list. */
  contentStableTs: number | null
  resources: CapturedResource[]
  commits: CapturedCommit[]
  /** fiber-unmount events during the switch, by component name. */
  unmounts: string[]
  /** layout-shift values kept INCLUDING hadRecentInput (click-triggered). */
  layoutShifts: Array<{ ts: number; value: number; hadRecentInput: boolean }>
  /** true if react-scan reported profiling hooks degraded. */
  degraded: boolean
}

export interface CaptureFile {
  owner: { email: string; userId: string }
  createdAt: string
  switches: CapturedSwitch[]
}

// In-page globals installed by the perf spec's PerformanceObserver setup.
// Declared here so the spec's page.evaluate callbacks typecheck under tsc.
declare global {
  interface Window {
    __PERF_RESOURCES__?: Array<{ name: string; startTime: number; responseEnd: number }>
    __PERF_SHIFTS__?: Array<{ ts: number; value: number; hadRecentInput: boolean }>
    __PERF_RESIZES__?: number[]
    __PERF_RESIZE_OBSERVER__?: ResizeObserver
    __PERF_ATTACH_RESIZE__?: () => boolean
    __PERF_SKELETON_TS__?: number | null
    __PERF_PAINTED_TS__?: number | null
  }
}
