import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import type { Faro } from "@grafana/faro-web-sdk"
import { installBrowserObservers } from "./browser"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"

const events: Array<{ name: string; attributes: Record<string, string> }> = []
let dispose: (() => void) | undefined
beforeEach(() => {
  events.length = 0
  act(() => configureTelemetry({ session_id: "browser-session" }, true))
  installTelemetrySink(event => events.push(event))
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
})
afterEach(() => { dispose?.(); dispose = undefined; retireTelemetry(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it("redacts browser errors and rejections, excludes private frames and stops retired listeners", () => {
  const pushError = vi.fn(), faro = { api: { pushError } } as unknown as Faro
  dispose = installBrowserObservers(faro, "https://collector.example/collect/public")
  const prevent = (event: Event) => event.preventDefault()
  window.addEventListener("error", prevent)
  try {
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("private-body"), message: "private-body", filename: window.location.origin + "/_next/static/chunks/a.js?token=private", lineno: 4, colno: 8, cancelable: true }))
    window.dispatchEvent(new ErrorEvent("error", { filename: "http://[", cancelable: true }))
    const rejection = new Event("unhandledrejection")
    Object.defineProperty(rejection, "reason", { value: new RangeError("private-rejection") })
    window.dispatchEvent(rejection)
    expect(pushError).toHaveBeenCalledTimes(3)
    expect(pushError.mock.calls[0]![1]).toMatchObject({ type: "TypeError", stackFrames: [{ filename: window.location.origin + "/_next/static/chunks/a.js", function: "[redacted]", lineno: 4, colno: 8 }] })
    expect(pushError.mock.calls[1]![1]).toMatchObject({ type: "Error", stackFrames: [] })
    expect(pushError.mock.calls[2]![1]).toMatchObject({ type: "RangeError", stackFrames: [] })
    expect(pushError.mock.calls.every(([error]) => error.message === "[redacted]")).toBe(true)
    retireTelemetry(); configureTelemetry({ session_id: "new-session" }, true)
    window.dispatchEvent(rejection)
    window.dispatchEvent(new ErrorEvent("error", { cancelable: true }))
    expect(pushError).toHaveBeenCalledTimes(3)
  } finally { window.removeEventListener("error", prevent) }
})
it("reports eligible resources with explicit kinds while excluding collector, old entries and retired callbacks", () => {
  const callbacks = new Map<string, (list: PerformanceObserverEntryList) => void>(), disconnect = vi.fn()
  class Observer {
    static supportedEntryTypes = ["resource", "longtask"]
    constructor(private callback: (list: PerformanceObserverEntryList) => void) {}
    observe({ type }: { type: string }) { callbacks.set(type, this.callback) }
    disconnect = disconnect
  }
  vi.stubGlobal("PerformanceObserver", Observer)
  dispose = installBrowserObservers({ api: { pushError: vi.fn() } } as unknown as Faro, "https://collector.example/collect/public", 10)
  const resource = (name: string, startTime = 20) => ({ name, startTime, duration: 8, transferSize: 12, encodedBodySize: 10, decodedBodySize: 14 }) as PerformanceEntry
  const send = (type: string, entries: PerformanceEntry[]) => callbacks.get(type)!({ getEntries: () => entries } as PerformanceObserverEntryList)
  send("resource", [resource("https://collector.example/collect/public"), resource("/collect/private"), resource("/api/agents", 0), resource("http://["), resource("/api/agents?token=private"), resource("/c/me/machines?_rsc=private"), resource("/_next/static/chunks/a.js?token=private"), resource("https://private.example/private")])
  expect(events.filter(event => event.name === "resource.finish").map(event => event.attributes.request_kind)).toEqual(["api", "rsc", "resource", "external"])
  expect(JSON.stringify(events)).not.toContain("private")
  send("longtask", [resource("longtask", 0), resource("longtask", 20)])
  expect(events.filter(event => event.name === "main_thread.longtask")).toHaveLength(1)
  const count = events.length
  retireTelemetry(); configureTelemetry({ session_id: "new-session" }, true)
  send("resource", [resource("/api/agents")])
  expect(events).toHaveLength(count)
  dispose(); dispose = undefined
  expect(disconnect).toHaveBeenCalledTimes(2)
})
it("reports unsupported and throwing observer capabilities without breaking content", () => {
  class Observer {
    static supportedEntryTypes = ["resource", "longtask"]
    constructor() { throw new Error("unavailable") }
  }
  vi.stubGlobal("PerformanceObserver", Observer)
  dispose = installBrowserObservers({ api: { pushError: vi.fn() } } as unknown as Faro, "https://collector.example/collect/public")
  expect(events).toHaveLength(2)
  expect(events.every(event => event.name === "telemetry.coverage" && event.attributes.capability === "unavailable")).toBe(true)
})
