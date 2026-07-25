import { log } from "@/lib/logger"
import { perfTraceEnabled } from "./perf-gate"
import { pushPerfEvent, type PerfEventRecord, type PerfFiberRecord } from "./perf-globals"
import type { LiteEvent, LiteFiberSummary, LiteHandle } from "react-scan/lite"

/**
 * Local render instrumentation install. Diagnosis-only (see
 * plans/community-switch-perf-diagnosis.md) — NEVER runs in a real build.
 *
 * Must run before react-dom installs its DevTools global hook, so this is
 * imported from `instrumentation-client.ts` (Next's pre-hydration client
 * entry), NOT a component mount effect. `instrument()` monkey-patches the
 * renderer; registering late loses the initial mount and possibly early
 * commits, and the `profiling-hooks-status.available` flag does not detect
 * that (it only reports whether the React build exposes the mark hooks).
 */

function toFiberRecord(f: LiteFiberSummary): PerfFiberRecord {
  const cd = f.changeDescription
  return {
    name: f.name,
    depth: f.depth,
    fiberId: f.fiberId,
    actualDuration: f.actualDuration,
    ownerName: f.ownerName,
    isFirstMount: cd?.isFirstMount,
    changedProps: cd?.props ?? null,
    changedState: cd?.state,
    changedContext: cd?.context,
    changedHooks: cd?.hooks,
    changedByParent: cd?.parent,
  }
}

function toRecord(event: LiteEvent): PerfEventRecord {
  return {
    kind: event.kind,
    ts: event.timestamp,
    priorityName: event.priorityName,
    didError: event.didError,
    componentName: event.componentName,
    available: event.available,
    fibers: event.tree?.map(toFiberRecord),
  }
}

/**
 * Install the react-scan lite instrument exactly once. No-ops when the perf
 * gate is off or when already installed (a shell/layout remount must not
 * double-`instrument()` and double every commit event).
 *
 * Returns the handle when it installed, or null when it no-op'd — the caller
 * (bootstrap component) uses the handle to stop on unmount.
 */
export async function installReactScan(): Promise<LiteHandle | null> {
  // Build-time exclusion FIRST. Next inlines `process.env.NODE_ENV` to the
  // string literal "production" in a prod build and runs dead-code elimination
  // on it, so this becomes `if (true) return null` and everything after —
  // including `import("react-scan/lite")` — is unreachable and dropped from the
  // graph, keeping the library (and its bippy core) out of the production
  // client bundle. Verified by build inspection (see plan finding-7): a runtime
  // `perfTraceEnabled()` / NEXT_PUBLIC_PERF_TRACE check alone does NOT DCE the
  // dynamic import — only the NODE_ENV literal does.
  if (process.env.NODE_ENV === "production") return null
  if (!perfTraceEnabled()) return null
  if (typeof window === "undefined") return null
  if (window.__ALOOK_PERF_INSTALLED__) return null
  window.__ALOOK_PERF_INSTALLED__ = true

  const { instrument } = await import("react-scan/lite")

  const handle = instrument({
    recordChangeDescriptions: true,
    includeFiberSource: true,
    includeFiberIdentity: true,
    onEvent: (event) => {
      if (event.kind === "profiling-hooks-status" && event.available === false) {
        window.__ALOOK_PERF_DEGRADED__ = true
        log.warn(
          "[perf] react-scan profiling hooks unavailable — render data will be incomplete",
          { reason: event.reason },
        )
      }
      pushPerfEvent(window, toRecord(event))
    },
  })

  log.info("[perf] react-scan instrument installed (NEXT_PUBLIC_PERF_TRACE=1)")
  activeHandle = handle
  return handle
}

/**
 * The live handle from the most recent install, so a component mounted later
 * in the tree (PerfTraceBootstrap) can stop it on unmount even though the
 * install itself happens pre-hydration in instrumentation-client.
 */
let activeHandle: LiteHandle | null = null

/**
 * Stop the active instrument (idempotent) and release the install guard so a
 * later flag-on session can re-arm cleanly.
 */
export function stopReactScan(): void {
  activeHandle?.stop()
  activeHandle = null
  if (typeof window !== "undefined") window.__ALOOK_PERF_INSTALLED__ = false
}
