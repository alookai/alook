import type { HrTime, Span } from "@opentelemetry/api"

export const transportClockStart = "alook.internal.http.start_ms"
export const transportClockEnd = "alook.internal.http.end_ms"

export function finishTransportClock(span: Span) {
  span.setAttribute(transportClockEnd, performance.now())
}

export function observationEpoch(now = performance.now()) {
  return performance.timeOrigin + now
}

export function observationTime(now: number): HrTime {
  const epoch = observationEpoch(now)
  const seconds = Math.floor(epoch / 1000)
  return [seconds, Math.floor((epoch - seconds * 1000) * 1e6)]
}
