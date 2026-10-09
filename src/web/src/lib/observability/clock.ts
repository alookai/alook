import type { HrTime } from "@opentelemetry/api"

export function observationEpoch(now = performance.now()) {
  return performance.timeOrigin + now
}

export function observationTime(now: number): HrTime {
  const epoch = observationEpoch(now)
  const seconds = Math.floor(epoch / 1000)
  return [seconds, Math.floor((epoch - seconds * 1000) * 1e6)]
}
