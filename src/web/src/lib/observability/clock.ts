import { createContextKey, type HrTime, type Span } from "@opentelemetry/api"

export const observationOwnerGeneration = createContextKey("alook.observation.owner.generation")
export const retiredObservationSpan = "alook.internal.owner.retired"
export function retireObservationSpan(span?: Span) { try { span?.setAttribute(retiredObservationSpan, true) } catch {} }

export const transportClockStart = "alook.internal.http.start_ms"
export const transportClockEnd = "alook.internal.http.end_ms"
export const transportClockOrigin = "alook.internal.http.origin_ms"

export function finishTransportClock(span: Span) {
  span.setAttribute(transportClockEnd, performance.now())
}

export function observationOrigin(now = performance.now()) {
  return Date.now() - now
}

export function observationEpoch(now = performance.now(), origin = observationOrigin()) {
  return origin + now
}

export function observationTime(now: number, origin = observationOrigin()): HrTime {
  const epoch = observationEpoch(now, origin)
  const seconds = Math.floor(epoch / 1000)
  return [seconds, Math.floor((epoch - seconds * 1000) * 1e6)]
}
