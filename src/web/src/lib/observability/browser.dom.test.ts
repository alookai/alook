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
  const send = (startTime: number) => callback({ getEntries: () => [{ startTime, duration: 80 }] } as PerformanceObserverEntryList)
  send(0); send(20)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ name: "main_thread.longtask", attributes: { start_ms: "20", duration_ms: "80" } })
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
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ name: "telemetry.coverage", attributes: { capability: "unavailable" } })
})
