"use client"

import { createContext, useContext, type ReactNode, Suspense, useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { commitNavigation, committedNavigationPathname, currentRoute, navigationForHref, finishAction, actionAttributes, startRegionObservation, finishRegionObservation, type Action, type PageOperation } from "./context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration, subscribeObservation, observationSnapshot } from "./telemetry"
import type { Attributes } from "./schema"

const visibility = createContext(true)
export function ObservedRegionVisibility({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(visibility)
  return <visibility.Provider value={parent && visible}>{children}</visibility.Provider>
}

export type ResourceObservation = { snapshot_source?: "rsc" | "network" | "restored_idb" | "unknown"; target_coverage?: "covered" | "uncovered" | "unknown"; wait_reason?: "none" | "entry" | "window" | "projection" | "identity" | "restore" | "position" | "render" | "virtual_window" | "unknown" }

export function useObservedRegion(region: Attributes["region"], ready: boolean, count?: number, evidence?: ResourceObservation, options?: { active?: boolean; primary?: boolean; href?: string }) {
  const visible = useContext(visibility)
  const active = options?.active ?? true, primary = options?.primary ?? true, expectedHref = options?.href
  const captureEvidence = useEffectEvent(() => evidence)
  const snapshotSource = evidence?.snapshot_source, targetCoverage = evidence?.target_coverage, waitReason = evidence?.wait_reason
  useSyncExternalStore(subscribeObservation, observationSnapshot, () => 0)
  const href = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search
  const pathname = committedNavigationPathname(), route = currentRoute(), navigation = navigationForHref(href), generation = telemetryGeneration(), eligible = isTelemetryEligible()
  const waiting = useRef<{ span?: PageOperation; action: Action; region: Attributes["region"]; evidenceKey: string } | undefined>(undefined)
  const closeWait = useEffectEvent((outcome: Attributes["outcome"], reason: Attributes["release_reason"]) => {
    const previous = waiting.current
    if (!previous) return
    finishRegionObservation(previous.span, previous.action, outcome, reason)
    waiting.current = undefined
  })
  useEffect(() => {
    if (!visible) { closeWait("cancelled", "hidden"); return }
    if (!eligible || generation !== telemetryGeneration()) { closeWait("cancelled", "retired"); return }
    if (expectedHref !== undefined && expectedHref !== href) { closeWait("cancelled", "route_mismatch"); return }
    if (!active) { closeWait("superseded", "condition_changed"); return }
    if (!navigation || navigation.done) { closeWait("cancelled", "navigation_changed"); return }
    if (href !== window.location.pathname + window.location.search || pathname !== undefined && pathname !== window.location.pathname) { closeWait("cancelled", "route_mismatch"); return }
    if (waiting.current && (waiting.current.action !== navigation || waiting.current.region !== region)) closeWait("cancelled", "navigation_changed")
    if (ready && waiting.current) { closeWait(count === 0 ? "empty" : "success", "ready"); return }
    const evidenceKey = JSON.stringify([snapshotSource, targetCoverage, waitReason])
    if (waiting.current && waiting.current.evidenceKey !== evidenceKey) closeWait("superseded", "condition_changed")
    if (!waiting.current) {
      waiting.current = { span: startRegionObservation(navigation, region, captureEvidence()), action: navigation, region, evidenceKey }
    }
    if (ready) closeWait(count === 0 ? "empty" : "success", "ready")
  }, [ready, visible, eligible, generation, href, pathname, navigation, region, count, snapshotSource, targetCoverage, waitReason, active, expectedHref])
  useEffect(() => () => closeWait("cancelled", "unmounted"), [])
  const emitted = useRef("")
  useEffect(() => {
    if (!active || !primary || !visible || !ready || !eligible || !isTelemetryEligible() || generation !== telemetryGeneration() || href !== window.location.pathname + window.location.search || expectedHref !== undefined && expectedHref !== href) return
    if (pathname !== undefined && pathname !== window.location.pathname) return
    const action = navigation && !navigation.done ? navigation : undefined
    const selectorReady = region === "sidebar" && ["/c/me", "/c/channels/[serverId]"].includes(route)
    if (!selectorReady && ["shell", "rail", "sidebar", "members", "thread_opener"].includes(String(region))) return
    const baseIdentity = String(generation) + ":" + href + ":"
    const identity = baseIdentity + (action?.id ?? "")
    if (identity === emitted.current || (!action && emitted.current.startsWith(baseIdentity))) return
    emitted.current = identity
    const fields = { ...actionAttributes(action), snapshot_source: snapshotSource, target_coverage: targetCoverage, wait_reason: "none", region, route_template: route, row_count: count, eligibility: "eligible", outcome: count === 0 ? "empty" : "success", phase: "primary" }
    emitTelemetry("region.ready_commit", fields)
    finishAction(action, "success", { region, phase: "primary" })
  }, [visible, ready, region, count, pathname, route, navigation, generation, eligible, href, snapshotSource, targetCoverage, active, primary, expectedHref])
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

export function ObservedStaticContent({ pathname }: { pathname?: string }) {
  const ready = pathname === undefined || (typeof window !== "undefined" && pathname === window.location.pathname)
  useObservedRegion("page", ready, 1)
  return null
}
