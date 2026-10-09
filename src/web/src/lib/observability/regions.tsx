"use client"

import { createContext, useContext, type ReactNode, Suspense, useEffect, useRef, useSyncExternalStore } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { commitNavigation, committedNavigationPathname, currentRoute, navigationForHref, finishAction, actionAttributes } from "./context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration, subscribeObservation, observationSnapshot } from "./telemetry"
import type { Attributes } from "./schema"

const visibility = createContext(true)
export function ObservedRegionVisibility({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(visibility)
  return <visibility.Provider value={parent && visible}>{children}</visibility.Provider>
}

export function useObservedRegion(region: Attributes["region"], ready: boolean, count?: number) {
  const visible = useContext(visibility)
  useSyncExternalStore(subscribeObservation, observationSnapshot, () => 0)
  const href = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search
  const pathname = committedNavigationPathname(), route = currentRoute(), navigation = navigationForHref(href), generation = telemetryGeneration(), eligible = isTelemetryEligible()
  const emitted = useRef("")
  useEffect(() => {
    if (!visible || !ready || !eligible || !isTelemetryEligible() || generation !== telemetryGeneration() || href !== window.location.pathname + window.location.search) return
    if (pathname !== undefined && pathname !== window.location.pathname) return
    const action = navigation && !navigation.done ? navigation : undefined
    const selectorReady = region === "sidebar" && ["/c/me", "/c/channels/[serverId]"].includes(route)
    if (!selectorReady && ["shell", "rail", "sidebar", "members", "thread_opener"].includes(String(region))) return
    const baseIdentity = String(generation) + ":" + href + ":"
    const identity = baseIdentity + (action?.id ?? "")
    if (identity === emitted.current || (!action && emitted.current.startsWith(baseIdentity))) return
    emitted.current = identity
    const fields = { ...actionAttributes(action), region, route_template: route, row_count: count, eligibility: "eligible", outcome: count === 0 ? "empty" : "success", phase: "primary" }
    emitTelemetry("region.ready_commit", fields)
    finishAction(action, "success", { region, phase: "primary" })
  }, [visible, ready, region, count, pathname, route, navigation, generation, eligible, href])
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
