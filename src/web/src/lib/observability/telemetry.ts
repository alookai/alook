import { cleanAttributes, type Attributes, type TelemetryEvent } from "./schema"
import { observationEpoch } from "./clock"

type RecordEvent = { name: TelemetryEvent; attributes: Record<string, string>; timestamp: number }
type Sink = (event: RecordEvent) => void
let eligible = false
let sink: Sink | undefined
let queue: RecordEvent[] = []
let dropped = 0
let generation = 0
let nativeContinuationFrom = -1
let base: Record<string, string> = {}
const LIMIT = 256
let revision = 0
const listeners = new Set<() => void>()
let notificationPending = false
export function observationSnapshot() { return revision }
export function subscribeObservation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function notifyObservation() {
  revision++
  if (notificationPending) return
  notificationPending = true
  queueMicrotask(() => { notificationPending = false; for (const listener of listeners) listener() })
}

export function isTelemetryEligible() { return eligible }
export function telemetryGeneration() { return generation }
export function configureTelemetry(attributes: Attributes, enabled: boolean) {
  base = cleanAttributes(attributes)
  eligible = enabled
  notifyObservation()
}
export function alignInitialTelemetrySession(previous: string, next: string) {
  if (!eligible || sink || base.session_id !== previous || !/^[a-zA-Z0-9_-]{1,80}$/.test(next) || queue.some(event => event.attributes.session_id !== previous)) return false
  base = { ...base, session_id: next }
  queue = queue.map(event => ({ ...event, attributes: { ...event.attributes, session_id: next } }))
  notifyObservation()
  return true
}
export function linkQueuedActionTrace(actionId: string, ownerGeneration: number, traceId: Attributes["trace_id"], spanId: Attributes["span_id"]) {
  if (!eligible || sink || ownerGeneration !== generation) return
  const fields = cleanAttributes({ trace_id: traceId, span_id: spanId })
  if (!fields.trace_id || !fields.span_id) return
  queue = queue.map(event => event.attributes.action_id === actionId ? { ...event, attributes: { ...event.attributes, ...fields } } : event)
}
export function retireTelemetry(reason: "boundary" | "native_session" = "boundary") {
  eligible = false
  nativeContinuationFrom = reason === "native_session" ? generation : -1
  generation++
  queue = []
  sink = undefined
  dropped = 0
  notifyObservation()
}
export function isNativeSessionContinuation(original: number) { return eligible && nativeContinuationFrom === original }
export function emitTelemetry(name: TelemetryEvent, attributes: Attributes = {}) {
  if (!eligible) return
  const event = { name, attributes: cleanAttributes({ ...base, ...attributes, schema_version: 1 }), timestamp: observationEpoch() }
  if (sink) { try { sink(event) } catch { dropped++ } }
  else if (queue.length < LIMIT) queue.push(event)
  else dropped++
}
export function installTelemetrySink(next: Sink) {
  if (!eligible) return
  sink = next
  const pending = queue
  queue = []
  for (const event of pending) { try { next(event) } catch { dropped++ } }
  reportTelemetryDrops()
}
export function reportTelemetryDrops(reason: Attributes["drop_reason"] = "early_queue_full") {
  if (!eligible || !sink || dropped === 0) return
  const count = dropped
  dropped = 0
  emitTelemetry("telemetry.drop", { drop_count: count, drop_reason: reason })
}
