import { actionAttributes, telemetryId, type Action } from "./context"
import { routeTemplate } from "./coverage"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { tagNetworkResponse } from "./data-source"
import type { Attributes } from "./schema"
import { context, trace } from "@opentelemetry/api"

export type RequestObservation = { id: string; start: number; generation: number; fields: Attributes; done: boolean; action?: Action }
const responses = new WeakMap<Response, RequestObservation>()
export function startRequest(path: string, options?: { method?: string; observation?: { action?: Action; reason?: Attributes["request_reason"] } }): RequestObservation | undefined {
  if (!isTelemetryEligible()) return
  const origin = typeof window === "undefined" ? "https://alook.ai" : window.location.origin
  const fields = { ...actionAttributes(options?.observation?.action), route_template: routeTemplate(path, origin), method: options?.method ?? "GET", request_reason: options?.observation?.reason ?? "unknown", request_kind: "api", eligibility: "unknown" }
  const request = { id: telemetryId(), start: performance.now(), generation: telemetryGeneration(), fields, done: false, action: options?.observation?.action }
  emitTelemetry("request.start", { ...fields, request_id: request.id, start_ms: request.start })
  return request
}
export function runObservedFetch<T>(request: RequestObservation | undefined, execute: () => T): T {
  const action = request?.action
  return action?.span && !action.done && action.generation === telemetryGeneration() && isTelemetryEligible()
    ? context.with(trace.setSpan(context.active(), action.span), execute)
    : execute()
}
function fields(request?: RequestObservation): Attributes {
  return request ? { ...request.fields, request_id: request.id, start_ms: request.start, duration_ms: performance.now() - request.start } : {}
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
