import type { Span } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-web"
import { observationTime } from "./clock"
import { readTraceResponse } from "./trace-response"

const responseMatched = "alook.internal.resource.response_matched"
export const networkEventNames = ["fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "responseEnd"] as const
const networkNames = new Set<string>(networkEventNames)
const protocols = new Set(["http/1.0", "http/1.1", "h2", "h3"])

export function observeResourceResponse(span: Span, header: string) {
  const response = readTraceResponse(header, span.spanContext())
  span.setAttribute(responseMatched, response.matched)
  span.setAttribute("server_sampling", response.sampling)
  span.setAttribute("server_identity", response.server ? "available" : "unavailable")
  if (response.server) {
    span.setAttribute("server_trace_id", response.server.traceId)
    span.setAttribute("server_span_id", response.server.spanId)
    span.addLink({ context: response.server, attributes: { relationship: "server_response" } })
  }
}

export function projectResource(span: ReadableSpan, origin: number) {
  const unrelated = span.events.filter(event => !networkNames.has(event.name))
  const discarded = span.events.length - unrelated.length
  const unavailable = (resource_status: string) => ({ events: unrelated, attributes: { ...span.attributes, resource_status }, discarded })
  if (span.attributes[responseMatched] !== true) return unavailable("unavailable")
  if (typeof performance.getEntriesByType !== "function") return unavailable("unsupported")
  const context = span.spanContext()
  const identity = context.traceId + "-" + context.spanId
  const resources = performance.getEntriesByType("resource").filter((entry): entry is PerformanceResourceTiming => "serverTiming" in entry)
    .filter(entry => {
      const markers = Array.from(entry.serverTiming ?? []).filter(metric => metric.name === "alook_upstream")
      return markers.length === 1 && markers[0]?.description === identity
    })
  if (resources.length !== 1) return unavailable(resources.length ? "ambiguous" : "missing")
  const resource = resources[0]!
  const finite = (value: number) => Number.isFinite(value) && value >= 0
  const events = networkEventNames.flatMap(name => finite(resource[name]) && resource[name] > 0
    ? [{ name, time: observationTime(resource[name], origin), attributes: {} }] : [])
  const cache = resource.transferSize === 0 && resource.decodedBodySize > 0 ? "cache"
    : resource.responseStatus === 304 ? "conditionalFetch" : "fullLoad"
  const attributes = {
    ...span.attributes,
    resource_status: "matched", network_event_source: "resource_identity", cache_hit_status: cache,
    ...(protocols.has(resource.nextHopProtocol) ? { network_protocol: resource.nextHopProtocol } : {}),
    ...(["fetch", "xmlhttprequest"].includes(resource.initiatorType) ? { initiator_type: resource.initiatorType } : {}),
  }
  for (const [key, value] of Object.entries({ transfer_bytes: resource.transferSize, encoded_bytes: resource.encodedBodySize, decoded_bytes: resource.decodedBodySize })) {
    if (finite(value)) Object.assign(attributes, { [key]: value })
  }
  return { events: [...unrelated, ...events], attributes, discarded: 0 }
}
