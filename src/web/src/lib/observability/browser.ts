import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { actionAttributes, currentPageObservation, telemetryId } from "./context"
import type { Attributes } from "./schema"

type ScriptTiming = Partial<PerformanceEntry> & { executionStart?: number; forcedStyleAndLayoutDuration?: number; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; invokerType?: string }
type FrameTiming = PerformanceEntry & { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: readonly ScriptTiming[] }
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function ownerFields(start: number) {
  const page = currentPageObservation()
  return page && start >= page.start ? actionAttributes(page) : {}
}

function scriptFields(script: ScriptTiming): Attributes {
  let source: string | undefined
  try {
    const url = new URL(script.sourceURL ?? "", window.location.origin)
    if (url.origin === window.location.origin && !url.username && !url.password && /^\/_next\/static\/[a-zA-Z0-9_./~-]{1,220}\.js$/.test(url.pathname)) source = url.pathname
  } catch {}
  return {
    attribution_source: "script_entry", stack_status: "unavailable", source_status: source ? "available" : "unavailable",
    script_source: source,
    script_function: source ? script.sourceFunctionName : undefined,
    source_char_position: source && Number.isInteger(script.sourceCharPosition) && finite(script.sourceCharPosition) ? script.sourceCharPosition : undefined,
    invoker_type: script.invokerType,
    ...(finite(script.executionStart) ? { execution_start_ms: script.executionStart } : {}),
    ...(finite(script.forcedStyleAndLayoutDuration) ? { forced_layout_ms: script.forcedStyleAndLayoutDuration } : {}),
  }
}

export function installLongTaskObserver(since = 0) {
  const generation = telemetryGeneration()
  const observers: PerformanceObserver[] = []
  for (const type of ["longtask", "long-animation-frame"] as const) {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) {
      emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "background", attribution_source: type === "longtask" ? "long_task" : "long_animation_frame", stack_status: "unavailable" })
      continue
    }
    try {
      const observer = new PerformanceObserver(list => {
        if (!isTelemetryEligible() || generation !== telemetryGeneration()) return
        for (const entry of list.getEntries()) {
          if (!finite(entry.startTime) || !finite(entry.duration) || entry.startTime < since) continue
          const fields = { ...ownerFields(entry.startTime), start_ms: entry.startTime, duration_ms: entry.duration, phase: "background", stack_status: "unavailable" }
          if (type === "longtask") {
            emitTelemetry("main_thread.longtask", { ...fields, attribution_source: "long_task", capability: "limited" })
            continue
          }
          const frame = entry as FrameTiming, frameId = telemetryId()
          const admitted: ScriptTiming[] = []
          let count = 0
          for (const script of frame.scripts ?? []) if (finite(script.startTime) && finite(script.duration) && script.startTime >= since) {
            count++
            if (admitted.length < 8) admitted.push(script)
          }
          emitTelemetry("main_thread.long_animation_frame", {
            ...fields, frame_id: frameId, attribution_source: "long_animation_frame", capability: count ? "available" : "limited", count, drop_count: count - admitted.length,
            ...(finite(frame.blockingDuration) ? { blocking_duration_ms: frame.blockingDuration } : {}),
            ...(finite(frame.renderStart) ? { render_start_ms: frame.renderStart } : {}),
            ...(finite(frame.styleAndLayoutStart) ? { style_layout_start_ms: frame.styleAndLayoutStart } : {}),
          })
          for (const script of admitted) emitTelemetry("main_thread.script", { ...ownerFields(script.startTime!), ...scriptFields(script), frame_id: frameId, start_ms: script.startTime, duration_ms: script.duration, phase: "background" })
        }
      })
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch {
      emitTelemetry("telemetry.coverage", { capability: "unavailable", phase: "background", attribution_source: type === "longtask" ? "long_task" : "long_animation_frame", stack_status: "unavailable" })
    }
  }
  return () => { for (const observer of observers) observer.disconnect() }
}
