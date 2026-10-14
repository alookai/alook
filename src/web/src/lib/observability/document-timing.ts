import type { Span } from "@opentelemetry/api"
import { observationTime } from "./clock"
import { networkEventNames } from "./resource"
import { responseTraceContext } from "./trace-response"

export const documentEventNames = ["domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd"] as const

export function recordDocumentTiming(span: Span | undefined, origin: number, ready: number) {
  if (typeof performance.getEntriesByType !== "function") { span?.setAttribute("document_timing", "unavailable"); return }
  const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
  if (entries.length !== 1) { span?.setAttribute("document_timing", entries.length ? "ambiguous" : "missing"); return }
  const entry = entries[0]!
  const finite = (value: number) => Number.isFinite(value) && value > 0 && value <= ready
  const names = [...networkEventNames, ...documentEventNames]
  for (const name of names) if (finite(entry[name])) span?.addEvent(name, observationTime(entry[name], origin))
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
