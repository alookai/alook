import { observationObjectId } from "./image-correlation"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import type { Attributes } from "./schema"

export type AbortCause = "deadline" | "parent_signal" | "view_cleanup" | "view_retire" | "account_retire" | "read_superseded" | "query_signal" | "share_cleanup"
const metadata = new WeakMap<AbortSignal, Attributes>()
const parents = new WeakMap<AbortSignal, AbortSignal[]>()
const generations = new WeakMap<AbortSignal, number>()
const querySignals = new WeakMap<object, AbortSignal>()
const queryGenerations = new WeakMap<object, number>()

export function registerQueryObservationOwner(query: object) {
  if (!queryGenerations.has(query)) queryGenerations.set(query, telemetryGeneration())
}
export function queryObservationFields(query: object): Attributes | undefined {
  const generation = queryGenerations.get(query)
  return generation === telemetryGeneration() ? { query_id: observationObjectId(query), telemetry_generation: generation } : undefined
}

export function createObservedAbortController() {
  const controller = new AbortController()
  generations.set(controller.signal, telemetryGeneration())
  return controller
}
export function observeAbortSignal(signal: AbortSignal) {
  if (!generations.has(signal)) generations.set(signal, telemetryGeneration())
}

export function observeAbortDeadline(controller: AbortController, timeoutMs: number, generation = telemetryGeneration()) {
  const fields = { abort_owner_id: observationObjectId(controller), abort_cause: "unknown" }
  metadata.set(controller.signal, fields)
  generations.set(controller.signal, generation)
  if (generation === telemetryGeneration()) emitTelemetry("request.boundary", { ...fields, abort_phase: "timer_start", timeout_ms: timeoutMs, start_ms: performance.now(), time_origin_ms: performance.timeOrigin })
}

export function observeAccountQueryCancellation(queries: object[]) {
  for (const query of queries) {
    const signal = querySignals.get(query)
    if (signal && !signal.aborted) metadata.set(signal, { abort_cause: "account_retire", query_id: observationObjectId(query) })
    const fields = queryObservationFields(query)
    if (fields) emitTelemetry("query.boundary", { ...fields, query_boundary: "account_cancel", start_ms: performance.now() })
  }
}

export function linkObservedSignal(signal: AbortSignal, originals: AbortSignal[]) { parents.set(signal, originals) }
function setSignalObservation(signal: AbortSignal, fields: Attributes) { metadata.set(signal, fields) }
export function signalObservation(signal?: AbortSignal | null): Attributes {
  if (!signal) return { abort_cause: "unknown" }
  const original = parents.get(signal)?.find(parent => parent.aborted)
  return original ? signalObservation(original) : { abort_cause: "unknown", ...metadata.get(signal) }
}
export function abortObserved(controller: AbortController, cause: AbortCause, reason?: unknown) {
  if (!controller.signal.aborted) {
    const fields = { abort_cause: cause, abort_owner_id: observationObjectId(controller) }
    metadata.set(controller.signal, fields)
    const generation = generations.get(controller.signal)
    if (generation !== undefined && generation === telemetryGeneration()) emitTelemetry("request.boundary", { ...fields, abort_phase: "abort", start_ms: performance.now(), time_origin_ms: performance.timeOrigin })
  }
  controller.abort(reason)
}
export function observeQuerySignal(signal: AbortSignal | undefined, query: object | undefined) {
  if (!signal || !query) return () => {}
  const generation = telemetryGeneration()
  queryGenerations.set(query, generation)
  const fields = { abort_cause: "query_signal", query_id: observationObjectId(query) }
  observeAbortSignal(signal)
  setSignalObservation(signal, fields)
  querySignals.set(query, signal)
  const abort = () => {
    if (isTelemetryEligible() && generation === telemetryGeneration()) emitTelemetry("query.boundary", { ...signalObservation(signal), query_boundary: "signal_abort", start_ms: performance.now(), outcome: "cancelled" })
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  return () => { signal.removeEventListener("abort", abort); if (querySignals.get(query) === signal) querySignals.delete(query) }
}
