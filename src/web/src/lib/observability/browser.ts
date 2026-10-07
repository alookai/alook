import type { Faro } from "@grafana/faro-web-sdk"
import { routeTemplate } from "./coverage"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { installImageObservers, observeImageResource } from "./images"

export function installBrowserObservers(faro: Faro, collector: string, since = 0) {
  const generation = telemetryGeneration()
  const active = () => isTelemetryEligible() && generation === telemetryGeneration()
  const stopImages = installImageObservers(active)
  const error = (event: ErrorEvent) => {
    if (!active()) return
    const frames = []
    try {
      const url = new URL(event.filename, window.location.origin)
      if (url.origin === window.location.origin && /^\/(?:blog-static\/)?_next\/static\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) frames.push({ filename: url.origin + url.pathname, function: "[redacted]", lineno: event.lineno, colno: event.colno })
    } catch {}
    faro.api.pushError(new Error("[redacted]"), { type: event.error instanceof Error ? event.error.name : "Error", stackFrames: frames, skipDedupe: true })
  }
  const rejection = (event: PromiseRejectionEvent) => {
    if (!active()) return
    faro.api.pushError(new Error("[redacted]"), { type: event.reason instanceof Error ? event.reason.name : "Error", stackFrames: [], skipDedupe: true })
  }
  window.addEventListener("error", error)
  window.addEventListener("unhandledrejection", rejection)
  const observers: PerformanceObserver[] = []
  const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) {
      emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "transport", request_kind: type === "resource" ? "resource" : "unknown" })
      return
    }
    try {
      const observer = new PerformanceObserver(list => { if (active()) for (const entry of list.getEntries()) callback(entry) })
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch { emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "transport" }) }
  }
  observe("resource", entry => {
    try {
      const url = new URL(entry.name, window.location.origin)
      if (url.href === collector || url.pathname.startsWith("/collect/")) return
      const resource = entry as PerformanceResourceTiming
      if (resource.startTime < since) return
      const template = routeTemplate(url.href, window.location.origin)
      const kind = url.origin !== window.location.origin ? "external" : url.searchParams.has("_rsc") ? "rsc" : url.pathname.startsWith("/api/") ? "api" : "resource"
      emitTelemetry("resource.finish", { ...observeImageResource(resource), route_template: template, request_kind: kind, start_ms: resource.startTime, duration_ms: resource.duration, transfer_bytes: resource.transferSize, encoded_bytes: resource.encodedBodySize, decoded_bytes: resource.decodedBodySize, cache_stage: "http", source: "unknown", capability: "limited", phase: "background", outcome: "observed" })
    } catch {}
  })
  observe("longtask", entry => { if (entry.startTime >= since) emitTelemetry("main_thread.longtask", { start_ms: entry.startTime, duration_ms: entry.duration, phase: "background", capability: "limited" }) })
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
  if (navigation && navigation.startTime >= since) emitTelemetry("resource.finish", { route_template: routeTemplate(window.location.href, window.location.origin), request_kind: "document", start_ms: navigation.startTime, duration_ms: navigation.duration, phase: "background", capability: "limited", source: "unknown", outcome: "observed" })
  return () => { stopImages(); window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); for (const observer of observers) observer.disconnect() }
}
