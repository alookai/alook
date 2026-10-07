import type { Attributes } from "./schema"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"

let generation = -1
let start = 0
let count = 0
let dropped = 0
let timer: ReturnType<typeof setTimeout> | undefined
const LIMIT = 200

export function emitImageTelemetry(name: "image.lifecycle" | "image.operation", fields: () => Attributes) {
  if (!isTelemetryEligible()) return
  const current = telemetryGeneration(), now = performance.now()
  if (current !== generation) {
    clearTimeout(timer); timer = undefined; dropped = 0; count = 0; start = now; generation = current
  }
  if (now - start >= 1000) { count = 0; start = now }
  if (++count > LIMIT) {
    dropped++
    if (!timer) timer = setTimeout(() => {
      timer = undefined
      const total = dropped
      dropped = 0
      if (generation === current && isTelemetryEligible() && telemetryGeneration() === current) emitTelemetry("telemetry.drop", { drop_reason: "image_rate_limit", drop_count: total, capability: "limited" })
    }, 1000)
    return
  }
  emitTelemetry(name, fields())
}
