import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { installLongTaskObserver } from "./browser"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"

const events: Array<{ name: string; attributes: Record<string, string> }> = []
let dispose: (() => void) | undefined
beforeEach(() => {
  events.length = 0
  act(() => configureTelemetry({ session_id: "browser-session" }, true))
  installTelemetrySink(event => events.push(event))
})
afterEach(() => { dispose?.(); dispose = undefined; retireTelemetry(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it("reports only admitted long tasks and disconnects the retired observer", () => {
  let callback!: (list: PerformanceObserverEntryList) => void
  const disconnect = vi.fn()
  class Observer {
    static supportedEntryTypes = ["longtask"]
    constructor(handler: typeof callback) { callback = handler }
    observe = vi.fn()
    disconnect = disconnect
  }
  vi.stubGlobal("PerformanceObserver", Observer)
  dispose = installLongTaskObserver(10)
  expect(events.find(event => event.attributes.attribution_source === "long_animation_frame")?.attributes).toMatchObject({ capability: "unavailable", stack_status: "unavailable" })
  events.length = 0
  const send = (startTime: number) => callback({ getEntries: () => [{ startTime, duration: 80 }] } as PerformanceObserverEntryList)
  send(0); send(20)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ name: "main_thread.longtask", attributes: { start_ms: "20", duration_ms: "80", attribution_source: "long_task", stack_status: "unavailable" } })
  retireTelemetry(); configureTelemetry({ session_id: "new-session" }, true)
  send(30)
  expect(events).toHaveLength(1)
  dispose(); dispose = undefined
  expect(disconnect).toHaveBeenCalledOnce()
})
it.each(["unsupported", "throwing"])("reports a %s platform without breaking content", mode => {
  class Observer {
    static supportedEntryTypes = mode === "unsupported" ? [] : ["longtask"]
    constructor() { throw new Error("unavailable") }
  }
  vi.stubGlobal("PerformanceObserver", Observer)
  dispose = installLongTaskObserver()
  expect(events).toHaveLength(2)
  expect(events.every(event => event.name === "telemetry.coverage" && event.attributes.capability === "unavailable" && event.attributes.stack_status === "unavailable")).toBe(true)
})

it("uses native frame and script entry data, bounds detail and rejects unsafe source data without a fabricated stack", () => {
  let callback!: (list: PerformanceObserverEntryList) => void
  const disconnect = vi.fn()
  class Observer {
    static supportedEntryTypes = ["long-animation-frame"]
    constructor(handler: typeof callback) { callback = handler }
    observe = vi.fn()
    disconnect = disconnect
  }
  vi.stubGlobal("PerformanceObserver", Observer)
  dispose = installLongTaskObserver(10)
  events.length = 0
  const script = { startTime: 25, duration: 65, executionStart: 26, forcedStyleAndLayoutDuration: 4, sourceURL: window.location.origin + "/_next/static/chunks/a1.js?token=PRIVATE#PRIVATE", sourceFunctionName: "entryPoint", sourceCharPosition: 42, invokerType: "user-callback", invoker: "PRIVATE", stack: "PRIVATE" }
  const send = (entry: unknown) => callback({ getEntries: () => [entry] } as PerformanceObserverEntryList)
  send({ startTime: 0, duration: 100, scripts: [script] })
  expect(events).toEqual([])
  send({ startTime: 20, duration: 100, blockingDuration: 60, renderStart: 90, styleAndLayoutStart: 95, scripts: Array.from({ length: 10 }, () => script) })
  expect(events).toHaveLength(9)
  expect(events[0]).toMatchObject({ name: "main_thread.long_animation_frame", attributes: { start_ms: "20", duration_ms: "100", blocking_duration_ms: "60", count: "10", drop_count: "2", stack_status: "unavailable" } })
  expect(events[1]).toMatchObject({ name: "main_thread.script", attributes: { frame_id: events[0]!.attributes.frame_id, start_ms: "25", duration_ms: "65", execution_start_ms: "26", forced_layout_ms: "4", script_source: "/_next/static/chunks/a1.js", script_function: "entryPoint", source_char_position: "42", attribution_source: "script_entry", stack_status: "unavailable" } })
  expect(JSON.stringify(events)).not.toContain("PRIVATE")
  events.length = 0
  send({ startTime: 30, duration: 100, scripts: [{ ...script, sourceURL: "https://private.example/private.js", sourceFunctionName: "PRIVATE" }, { startTime: NaN, duration: 50 }] })
  expect(events).toHaveLength(2)
  expect(events[1]!.attributes.source_status).toBe("unavailable")
  expect(events[1]!.attributes).not.toHaveProperty("script_source")
  expect(events[1]!.attributes).not.toHaveProperty("script_function")
  expect(events[1]!.attributes).not.toHaveProperty("source_char_position")
  events.length = 0
  send({ startTime: 40, duration: 100 })
  expect(events[0]!.attributes).toMatchObject({ capability: "limited", count: "0", stack_status: "unavailable" })
  const count = events.length
  retireTelemetry(); configureTelemetry({ session_id: "replacement" }, true)
  send({ startTime: 50, duration: 100, scripts: [script] })
  expect(events).toHaveLength(count)
  dispose(); dispose = undefined
  expect(disconnect).toHaveBeenCalledOnce()
})
