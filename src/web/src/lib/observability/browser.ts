import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"

export function installLongTaskObserver(since = 0) {
  const generation = telemetryGeneration()
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "background" })
    return () => {}
  }
  try {
    const observer = new PerformanceObserver(list => {
      if (!isTelemetryEligible() || generation !== telemetryGeneration()) return
      for (const entry of list.getEntries()) if (entry.startTime >= since) emitTelemetry("main_thread.longtask", { start_ms: entry.startTime, duration_ms: entry.duration, phase: "background", capability: "limited" })
    })
    observer.observe({ type: "longtask", buffered: true })
    return () => observer.disconnect()
  } catch {
    emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "background" })
    return () => {}
  }
}
