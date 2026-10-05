"use client"

import { createContext, useContext, type ReactNode, Suspense, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { commitNavigation, currentRoute, navigationForHref, finishAction, actionAttributes } from "./context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration, subscribeObservation, observationSnapshot } from "./telemetry"
import { viewEvidence, mergeEvidence, type Evidence } from "./data-source"
import type { Attributes } from "./schema"

export function windowEvidence(values: readonly unknown[], emptySource?: unknown): Evidence {
  return values.length ? { ...mergeEvidence(values.map(viewEvidence)), count: values.length } : { ...viewEvidence(emptySource ?? values), count: 0 }
}
const visibility = createContext(true)
export function ObservedRegionVisibility({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(visibility)
  return <visibility.Provider value={parent && visible}>{children}</visibility.Provider>
}

export function useObservedRegion(region: Attributes["region"], ready: boolean, evidence: Evidence) {
  const visible = useContext(visibility)
  const revision = useSyncExternalStore(subscribeObservation, observationSnapshot, () => 0)
  const href = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search
  const signature = evidence.version + ":" + evidence.source + ":" + evidence.freshness + ":" + evidence.count + ":" + (evidence.wsEventId ?? "")
  const rendered = useMemo(() => ({ ...evidence, signature, observationRevision: revision, route: currentRoute(), href, action: navigationForHref(href), generation: telemetryGeneration() }), [evidence, signature, href, revision])
  const emitted = useRef("")
  useEffect(() => {
    if (!visible || !ready || !isTelemetryEligible() || rendered.generation !== telemetryGeneration() || rendered.href !== window.location.pathname + window.location.search) return
    const action = rendered.action && !rendered.action.done ? rendered.action : undefined
    const baseIdentity = String(rendered.generation) + ":" + rendered.href + ":" + rendered.signature + ":"
    const identity = baseIdentity + (action?.id ?? "")
    if (identity === emitted.current || (!action && emitted.current.startsWith(baseIdentity))) return
    emitted.current = identity
    const fields = { ...actionAttributes(action), region, ws_event_id: rendered.wsEventId, ws_duration_ms: rendered.wsStart === undefined ? undefined : performance.now() - rendered.wsStart, route_template: rendered.route, source: rendered.source, data_version: rendered.version, freshness: rendered.freshness, row_count: rendered.count, eligibility: "eligible", outcome: rendered.count ? "success" : "empty", phase: action ? "primary" : "background" }
    emitTelemetry("region.read", fields)
    emitTelemetry("region.ready_commit", fields)
    const selectorReady = region === "sidebar" && ["/c/me", "/c/channels/[serverId]"].includes(rendered.route)
    if (selectorReady || !["shell", "rail", "sidebar", "members", "thread_opener"].includes(String(region))) finishAction(action, "success", { region, phase: "primary" })
    if (document.visibilityState !== "visible" || typeof requestAnimationFrame !== "function") {
      emitTelemetry("region.frame_estimate", { ...fields, capability: "unavailable", visibility: document.visibilityState })
      return
    }
    const start = performance.now()
    const handle = requestAnimationFrame(() => { if (rendered.generation === telemetryGeneration() && isTelemetryEligible()) emitTelemetry("region.frame_estimate", { ...fields, duration_ms: performance.now() - start, phase: "frame", capability: "limited", visibility: document.visibilityState }) })
    return () => cancelAnimationFrame(handle)
  }, [visible, ready, region, rendered, signature])
}
function RouteCommit() {
  const pathname = usePathname(), search = useSearchParams().toString()
  useEffect(() => {
    if (pathname.startsWith("/c")) return
    commitNavigation(pathname + (search ? "?" + search : ""), "page")
  }, [pathname, search])
  return null
}
export function ObservedRouteCommit() { return <Suspense fallback={null}><RouteCommit /></Suspense> }

export function ObservedStaticContent() {
  useObservedRegion("page", true, { source: "unknown", version: "ssr_committed", freshness: "unknown", count: 1 })
  return null
}
