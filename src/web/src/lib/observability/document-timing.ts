import type { Span } from "@opentelemetry/api"
import { observationTime } from "./clock"
import { networkEventNames } from "./resource"
import { responseTraceContext } from "./trace-response"
import type { Attributes } from "./schema"

export const documentEventNames = ["domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd"] as const

export function documentTimingAttributes(observedAt: number): Attributes {
  const fields: Attributes = { document_elapsed_ms: observedAt, document_ready_state: typeof document === "undefined" ? "unknown" : document.readyState }
  if (typeof performance.getEntriesByType !== "function") return { ...fields, document_timing: "unavailable" }
  let entries: PerformanceNavigationTiming[]
  try { entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[] } catch { return { ...fields, document_timing: "unavailable" } }
  if (entries.length !== 1) return { ...fields, document_timing: entries.length ? "ambiguous" : "missing" }
  const entry = entries[0]!
  for (const [field, name] of Object.entries({ document_response_end_ms: "responseEnd", document_dom_interactive_ms: "domInteractive", document_dcl_end_ms: "domContentLoadedEventEnd", document_dom_complete_ms: "domComplete", document_load_ms: "loadEventEnd" } as const)) {
    const value = entry[name]
    if (Number.isFinite(value) && value > 0 && value <= observedAt) fields[field] = value
  }
  return { ...fields, document_timing: documentEventNames.every(name => Number.isFinite(entry[name]) && entry[name] > 0 && entry[name] <= observedAt) ? "matched" : "partial" }
}

export function recordDocumentTiming(span: Span | undefined, origin: number, ready: number, observedStart = 0) {
  if (typeof performance.getEntriesByType !== "function") { span?.setAttribute("document_timing", "unavailable"); return }
  const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
  if (entries.length !== 1) { span?.setAttribute("document_timing", entries.length ? "ambiguous" : "missing"); return }
  const entry = entries[0]!
  const finite = (value: number) => Number.isFinite(value) && value > 0 && value <= ready
  const names = [...networkEventNames, ...documentEventNames]
  for (const name of names) if (finite(entry[name]) && entry[name] >= observedStart) span?.addEvent(name, observationTime(entry[name], origin))
  span?.setAttribute("document_timing", documentEventNames.every(name => finite(entry[name])) ? "matched" : "partial")
  span?.setAttribute("network_event_source", "document_navigation")
  const serverTiming = Array.from(entry.serverTiming ?? [])
  const contexts = serverTiming.filter(metric => metric.name === "alook_server")
  const server = contexts.length === 1 ? responseTraceContext(contexts[0]?.description) : undefined
  const sampling = serverTiming.filter(metric => metric.name === "alook_sampling")
  span?.setAttribute("server_identity", server ? "available" : "unavailable")
  span?.setAttribute("server_sampling", sampling.length === 1 && ["selected", "not_selected"].includes(sampling[0]!.description) ? sampling[0]!.description : "unavailable")
  if (server) {
    span?.setAttribute("server_trace_id", server.traceId)
    span?.setAttribute("server_span_id", server.spanId)
    span?.addLink({ context: server, attributes: { relationship: "document_response" } })
  }
}
