"use client"

import { useEffect } from "react"
import { perfTraceEnabled } from "@/lib/perf/perf-gate"
import { installReactScan } from "@/lib/perf/react-scan-install"

/**
 * Diagnosis-only marker mounted once in the community shell. The real install
 * happens pre-hydration in `instrumentation-client.ts`; this component just
 * ENSURES it (idempotent — the single-install guard makes a repeat call a
 * no-op) so instrumentation is present even if the client entry didn't run for
 * some reason.
 *
 * Crucially it does NOT stop the instrument on unmount: the instrument's
 * lifetime is the whole tab/page session, and a React effect cleanup (which
 * StrictMode double-invokes in dev) must never detach react-scan's commit hook
 * — doing so was silently killing all post-mount capture (~300ms in), which is
 * exactly the switch data we need. See plans/community-switch-perf-diagnosis.md.
 *
 * Renders nothing and does nothing when the perf gate is off, so it is inert in
 * every real build.
 */
export function PerfTraceBootstrap() {
  useEffect(() => {
    if (!perfTraceEnabled()) return
    void installReactScan().catch(() => {})
    // No cleanup: the instrument lives for the page session, not the effect.
  }, [])

  return null
}
