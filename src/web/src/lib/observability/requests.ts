import { actionAttributes, telemetryId, navigationForHref, prefetchForHref, type Action } from "./context"
import { routeTemplate } from "./coverage"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { tagNetworkResponse } from "./data-source"
import { cleanAttributes, type Attributes } from "./schema"
import { context, trace, createContextKey, type Span } from "@opentelemetry/api"

export type RequestObservation = { id: string; start: number; generation: number; fields: Attributes; done: boolean; action?: Action }
const responses = new WeakMap<Response, RequestObservation>()
const requestContext = createContextKey("alook.request")
const transportRequests = new WeakMap<Span, RequestObservation>()
export function startRequest(path: string, options?: { method?: string; kind?: Attributes["request_kind"]; observation?: { action?: Action; reason?: Attributes["request_reason"] } }): RequestObservation | undefined {
  if (!isTelemetryEligible()) return
  const origin = typeof window === "undefined" ? "https://alook.ai" : window.location.origin
  const fields = { ...actionAttributes(options?.observation?.action), route_template: routeTemplate(path, origin), method: options?.method ?? "GET", request_reason: options?.observation?.reason ?? "unknown", request_kind: options?.kind ?? "api", eligibility: "unknown" }
  const request = { id: telemetryId(), start: performance.now(), generation: telemetryGeneration(), fields, done: false, action: options?.observation?.action }
  emitTelemetry("request.start", { ...fields, request_id: request.id, start_ms: request.start })
  return request
}
export function runObservedFetch<T>(request: RequestObservation | undefined, execute: () => T): T {
  const action = request?.action
  if (!request || request.generation !== telemetryGeneration() || !isTelemetryEligible()) return execute()
  const original = context.active().setValue(requestContext, request)
  return context.with(action?.span && action.generation === request.generation ? trace.setSpan(original, action.span) : original, execute)
}

export function observeTransportSpan(span: Span) {
  const request = context.active().getValue(requestContext) as RequestObservation | undefined
  if (!request || request.generation !== telemetryGeneration() || !isTelemetryEligible()) return
  transportRequests.set(span, request)
  const native = span.spanContext()
  request.fields = { ...request.fields, trace_id: native.traceId, span_id: native.spanId }
  for (const [key, value] of Object.entries(cleanAttributes({ ...request.fields, request_id: request.id }))) span.setAttribute(key, value)
}

export function finishTransportSpan(span: Span, result: unknown) {
  const request = transportRequests.get(span)
  transportRequests.delete(span)
  if (request?.fields.request_kind !== "rsc") return
  finishRequest(request, result instanceof Response ? "observed" : "error", "body")
}

export function installNavigationFetchContext() {
  const original = window.fetch
  const observed: typeof fetch = (input, init) => {
    let url: URL
    try { url = new URL(input instanceof Request ? input.url : String(input), window.location.origin) } catch { return original(input, init) }
    if (url.origin !== window.location.origin || !url.searchParams.has("_rsc") || !isTelemetryEligible()) return original(input, init)
    url.searchParams.delete("_rsc")
    const href = url.pathname + url.search
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const prefetch = headers.has("next-router-prefetch") || headers.get("purpose") === "prefetch"
    const action = prefetch ? prefetchForHref(href) : navigationForHref(href)
    const request = startRequest(url.href, { kind: "rsc", observation: { action, reason: prefetch ? "prefetch" : "router" } })
    return runObservedFetch(request, () => original(input, init)).then(response => {
      requestHeaders(request, response)
      return response
    }, error => { finishRequest(request, "error", "headers"); throw error })
  }
  window.fetch = observed
  return () => { if (window.fetch === observed) window.fetch = original }
}
function fields(request?: RequestObservation): Attributes {
  const current = request?.action?.generation === telemetryGeneration() ? actionAttributes(request.action) : {}
  return request ? { ...request.fields, trace_id: request.fields.trace_id ?? current.trace_id, span_id: request.fields.span_id ?? current.span_id, request_id: request.id, start_ms: request.start, duration_ms: performance.now() - request.start } : {}
}
export function requestHeaders(request: RequestObservation | undefined, response: Response) {
  if (!request || request.generation !== telemetryGeneration()) return
  const ray = response.headers.get("cf-ray") ?? undefined
  request.fields = { ...request.fields, status: response.status, cf_ray: ray }
  responses.set(response, request)
  emitTelemetry("request.headers", { ...fields(request), phase: "headers" })
}
function requestBodyParsed(response: Response) {
  const request = responses.get(response)
  if (request && request.generation === telemetryGeneration()) emitTelemetry("request.body_parsed", { ...fields(request), phase: "body" })
}
export function requestRejected(request: RequestObservation | undefined) {
  if (request && request.generation === telemetryGeneration()) emitTelemetry("data.response_rejected", { ...fields(request), eligibility: "rejected", outcome: "rejected" })
}
export function finishRequest(request: RequestObservation | undefined, outcome: Attributes["outcome"], phase: "body" | "headers", eligibility: Attributes["eligibility"] = "unknown") {
  if (!request || request.done) return
  request.done = true
  if (request.generation === telemetryGeneration()) emitTelemetry("request.finish", { ...fields(request), outcome, phase, eligibility })
}
export async function readObservedResponse<T>(response: Response, read: () => Promise<T>, qualify?: () => void): Promise<T> {
  const request = responses.get(response)
  try {
    const value = await read()
    requestBodyParsed(response)
    try { qualify?.() } catch (error) { requestRejected(request); throw error }
    if (request?.generation === telemetryGeneration()) tagNetworkResponse(value)
    finishRequest(request, "success", "body", "eligible")
    return value
  } catch (error) {
    finishRequest(request, error instanceof Error && error.name === "AbortError" ? "cancelled" : "error", "body")
    throw error
  } finally { responses.delete(response) }
}
