import { ROOT_CONTEXT } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { beginNavigation, clearActions, finishAction, installActionSpans } from "./context"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"
import { documentTimingAttributes } from "./document-timing"

afterEach(() => act(() => { retireTelemetry(); clearActions(); installActionSpans(undefined); vi.restoreAllMocks(); window.history.replaceState(null, "", "/") }))

it("keeps a slow initial load on the document clock instead of disguising it as the observed tail", async () => {
  let now = 10_000
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  configureTelemetry({ session_id: "initial-document" }, true)
  installTelemetrySink(event => events.push(event))
  const action = beginNavigation("/c/me/machines", "document")!
  now = 12_000
  finishAction(action, "success", { phase: "primary", region: "machines" })
  expect(events.find(event => event.name === "navigation.ready")?.attributes).toMatchObject({ start_ms: "0", duration_ms: "12000", observation_start_ms: "10000", observed_duration_ms: "2000", document_elapsed_ms: "12000", document_timing: "missing" })
  expect(events.some(event => event.name === "document.observed")).toBe(false)
})

it("separates a two-hour document from its 166ms observation and retains its actual 8.625s load", async () => {
  let now = 7_200_000
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ responseEnd: 8000, domInteractive: 8100, domContentLoadedEventStart: 8200, domContentLoadedEventEnd: 8250, domComplete: 8500, loadEventStart: 8600, loadEventEnd: 8625, serverTiming: [{ name: "alook_server", description: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`, duration: 0 }, { name: "alook_sampling", description: "selected", duration: 0 }] } as PerformanceNavigationTiming])
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  configureTelemetry({ session_id: "late-document" }, true)
  installTelemetrySink(event => events.push(event))
  installActionSpans((name, attributes, startTime, links) => provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, ROOT_CONTEXT))
  const action = beginNavigation("/c/me/machines", "document_observation")!
  now += 166
  finishAction(action, "success", { phase: "primary", region: "machines" })
  expect(events.some(event => event.name === "navigation.ready")).toBe(false)
  expect(events.find(event => event.name === "document.observed")?.attributes).toMatchObject({ navigation_kind: "document_observation", start_ms: "7200000", duration_ms: "166", observed_duration_ms: "166", document_elapsed_ms: "7200166", document_response_end_ms: "8000", document_load_ms: "8625", document_timing: "matched" })
  const span = exporter.getFinishedSpans()[0]!
  expect((span.duration[0] * 1e9 + span.duration[1]) / 1e6).toBeCloseTo(166, 2)
  expect(span.attributes).toMatchObject({ document_load_ms: "8625", document_elapsed_ms: "7200166" })
  expect(span.events).toEqual([])
  expect(span.links).toMatchObject([{ context: { traceId: "a".repeat(32), spanId: "b".repeat(16) }, attributes: { relationship: "document_response" } }])
  expect(span.attributes).toMatchObject({ server_identity: "available", server_sampling: "selected" })
  await provider.shutdown()
})

it("reports unavailable, ambiguous and invalid document timing without inventing a load", () => {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ loadEventEnd: Infinity, responseEnd: -1, domComplete: 1000 } as PerformanceNavigationTiming])
  expect(documentTimingAttributes(100)).toMatchObject({ document_elapsed_ms: 100, document_timing: "partial" })
  expect(documentTimingAttributes(100)).not.toHaveProperty("document_load_ms")
  vi.mocked(performance.getEntriesByType).mockReturnValue([{}, {}] as PerformanceEntry[])
  expect(documentTimingAttributes(100).document_timing).toBe("ambiguous")
  vi.mocked(performance.getEntriesByType).mockImplementation(() => { throw new Error("unavailable") })
  expect(documentTimingAttributes(100).document_timing).toBe("unavailable")
})
