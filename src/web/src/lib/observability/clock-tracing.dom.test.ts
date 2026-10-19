import { afterEach, expect, it, vi } from "vitest"
import type { Faro } from "@grafana/faro-web-sdk"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const native = vi.hoisted(() => ({ faro: undefined as Faro | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => { native.faro = real.initializeFaro(...args); return native.faro } }
})

afterEach(async () => {
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  })
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("normalizes real native HTTP exports and mirrors, retaining missing-hook and retired-session boundaries", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  let now = 1000, drift = 230_000, mode = "success"
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  vi.setSystemTime(performance.timeOrigin + now + drift)
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {})
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {})
  vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(() => {})
  const sent: unknown[] = []
  let settle: ((response: Response) => void) | undefined
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
    if (String(input) === "https://collector.example/collect/public") {
      if (options?.body) sent.push(JSON.parse(String(options.body)))
      return new Response(null, { status: 204 })
    }
    if (mode === "pending") return new Promise<Response>(resolve => { settle = resolve })
    now += 12
    if (mode !== "clone-failure" && mode !== "reader-failure") { drift *= -1; vi.setSystemTime(performance.timeOrigin + now + drift) }
    if (mode === "error") throw new TypeError("fixture failure")
    if (mode === "abort") throw new DOMException("fixture cancellation", "AbortError")
    const response = new Response(mode === "body" || mode === "reader-failure" ? "{}" : null, { status: mode === "http-error" ? 500 : 200 })
    if (mode === "clone-failure") vi.spyOn(response, "clone").mockImplementation(() => { throw new TypeError("fixture clone failure") })
    if (mode === "reader-failure") vi.spyOn(response, "clone").mockImplementation(() => {
      const clone = new Response("{}")
      Object.defineProperty(clone, "body", { value: { getReader: () => { throw new TypeError("fixture reader failure") } } })
      return clone
    })
    return response
  }))
  const consent = (value: "granted" | "denied") => { document.cookie = "alook_analytics_consent=v1." + value + "; path=/"; announceAnalyticsConsent(value) }
  consent("granted")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { emitTelemetry } = await import("./telemetry")
  await act(async () => { bootstrapObservability("web"); setTelemetryUser("account-a") })
  await vi.waitFor(() => expect(native.faro).toBeDefined())
  const exported = () => {
    const spans: Record<string, unknown>[] = [], events: Array<{ name: string; attributes: Record<string, string>; trace?: { span_id: string } }> = []
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const row = value as Record<string, unknown>
      if (typeof row.spanId === "string") spans.push(row)
      if (typeof row.name === "string" && row.name.startsWith("faro.tracing.")) events.push(row as typeof events[number])
      for (const child of Object.values(row)) visit(child)
    }
    visit(sent)
    return { spans, events }
  }
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); now += 4000; await vi.advanceTimersByTimeAsync(3000) }
  const path = "/api/community/bots"
  for (const next of ["success", "body", "error", "abort", "http-error"]) {
    mode = next; const wallStart = Date.now()
    if (next === "error" || next === "abort") await expect(window.fetch(path)).rejects.toThrow()
    else await window.fetch(path)
    await flush()
    const { spans, events } = exported(), span = spans.filter(s => s.name === "GET /api/community/bots").at(-1)!
    expect(Number(span.startTimeUnixNano) / 1e6).toBeCloseTo(wallStart, 2)
    expect(Number(span.endTimeUnixNano) / 1e6).toBeCloseTo(wallStart + 12, 2)
    const mirror = events.find(e => e.trace?.span_id === span.spanId)!
    expect(mirror.name).toBe("faro.tracing.fetch")
    expect(Number(mirror.attributes.duration_ms)).toBeCloseTo(12, 2)
    if (next === "http-error") expect(span.status).toEqual({ code: 2 })
  }
  for (const event of ["load", "error", "abort", "timeout"]) {
    const wallStart = Date.now(), xhr = new XMLHttpRequest()
    xhr.open("GET", "/api/community/servers"); xhr.send()
    now += 17; drift *= -1; vi.setSystemTime(performance.timeOrigin + now + drift)
    Object.defineProperty(xhr, "status", { value: event === "load" ? 200 : 0 })
    xhr.dispatchEvent(new Event(event))
    await flush()
    const { spans, events } = exported(), span = spans.filter(s => s.name === "GET /api/community/servers").at(-1)!
    expect(Number(span.startTimeUnixNano) / 1e6).toBeCloseTo(wallStart, 2)
    expect(Number(span.endTimeUnixNano) / 1e6).toBeCloseTo(wallStart + 17, 2)
    const mirror = events.find(e => e.trace?.span_id === span.spanId)!
    expect(mirror.name).toBe("faro.tracing.xml-http-request")
    expect(Number(mirror.attributes.duration_ms)).toBeCloseTo(17, 2)
    if (event === "error" || event === "timeout") expect(span.status).toEqual({ code: 2 })
  }
  drift = 230_000; vi.setSystemTime(performance.timeOrigin + now + drift)
  for (const next of ["clone-failure", "reader-failure"]) {
    mode = next; const wallStart = Date.now(), start = now
    await window.fetch("/api/community/users/me/notifications")
    await flush()
    const span = exported().spans.filter(s => s.name === "GET /api/community/users/me/notifications").at(-1)!
    expect(Number(span.startTimeUnixNano) / 1e6).toBeCloseTo(wallStart, 2)
    expect(Number(span.startTimeUnixNano) / 1e6 - performance.timeOrigin).not.toBeCloseTo(start, 2)
  }
  for (const retirement of ["consent", "account", "native-session"]) {
    mode = "pending"
    const pending = window.fetch("/api/community/channels/retired/messages")
    const retiredSession = native.faro!.api.getSession()!.id!
    now += 20
    if (retirement === "consent") { consent("denied"); consent("granted") }
    else if (retirement === "account") setTelemetryUser("account-b")
    else { vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000); emitTelemetry("business.result", { outcome: "success" }) }
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(native.faro!.api.getSession()!.id).not.toBe(retiredSession))
    settle!(new Response(null, { status: 204 })); await pending; await flush()
    expect(exported().spans.some(s => s.name === "GET /api/community/channels/[id]/messages")).toBe(false)
    expect(exported().events.some(e => e.attributes.route_template === "/api/community/channels/[id]/messages")).toBe(false)
  }
  mode = "success"; const resumedStart = Date.now()
  await window.fetch(path); await flush()
  expect(Number(exported().spans.filter(s => s.name === "GET /api/community/bots").at(-1)!.startTimeUnixNano) / 1e6).toBeCloseTo(resumedStart, 2)
  expect(JSON.stringify(sent)).not.toContain("alook.internal.http")
})

it("preserves public identity, links and explicit manual/preflight timing without normalizing unrelated or incomplete spans", async () => {
  vi.useRealTimers()
  const { SpanKind, SpanStatusCode, ROOT_CONTEXT, trace } = await import("@opentelemetry/api")
  const { WebTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-web")
  const { ObservationClockProcessor } = await import("./clock-tracing")
  const { observationTime: toTime, observationOrigin, finishTransportClock, transportClockStart, transportClockEnd } = await import("./clock")
  let now = 400
  vi.spyOn(Date, "now").mockReturnValue(Date.now())
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const origin = observationOrigin(), observationTime = (value: number) => toTime(value, origin)
  const exporter = new InMemorySpanExporter(), processor = new ObservationClockProcessor(new SimpleSpanProcessor(exporter))
  const provider = new WebTracerProvider({ spanProcessors: [processor] })
  const manual = provider.getTracer("alook.frontend").startSpan("navigation", { startTime: observationTime(300) })
  const parent = manual.spanContext(), context = trace.setSpan(ROOT_CONTEXT, manual)
  const httpTracer = provider.getTracer("@opentelemetry/instrumentation-fetch", "0.222.0")
  const http = httpTracer.startSpan("GET", { kind: SpanKind.CLIENT, startTime: [1234, 0], links: [{ context: parent }] }, context)
  now = 500; finishTransportClock(http); http.setStatus({ code: SpanStatusCode.ERROR }); http.end([1235, 0])
  const preflight = httpTracer.startSpan("CORS Preflight", { kind: SpanKind.INTERNAL, startTime: observationTime(200) }, context)
  preflight.end(observationTime(250))
  const unrelated = provider.getTracer("alook.frontend").startSpan("explicit-client", { kind: SpanKind.CLIENT, startTime: observationTime(100), attributes: { [transportClockStart]: 400, [transportClockEnd]: 500 } })
  unrelated.end(observationTime(150))
  const incomplete = httpTracer.startSpan("missing-completion", { kind: SpanKind.CLIENT, startTime: [1234, 0] })
  now = 9000; incomplete.end([1235, 0]); manual.end(observationTime(900))
  await processor.forceFlush()
  const spans = exporter.getFinishedSpans(), normalized = spans.find(s => s.name === "GET")!
  expect(normalized.startTime).toEqual(observationTime(400)); expect(normalized.endTime).toEqual(observationTime(500)); expect(normalized.duration).toEqual([0, 100_000_000])
  expect(normalized.spanContext()).toEqual(http.spanContext()); expect(normalized.parentSpanContext).toEqual(parent)
  expect(normalized.links).toEqual([{ context: parent }]); expect(normalized.status).toEqual({ code: SpanStatusCode.ERROR })
  expect(normalized.instrumentationScope).toEqual({ name: "@opentelemetry/instrumentation-fetch", version: "0.222.0", schemaUrl: undefined })
  expect(spans.find(s => s.name === "CORS Preflight")!.startTime).toEqual(observationTime(200))
  expect(spans.find(s => s.name === "CORS Preflight")!.endTime).toEqual(observationTime(250))
  expect(spans.find(s => s.name === "explicit-client")!.startTime).toEqual(observationTime(100))
  expect(spans.find(s => s.name === "missing-completion")!.startTime).toEqual([1234, 0])
  expect(spans.find(s => s.name === "missing-completion")!.endTime).toEqual([1235, 0])
  expect(spans.find(s => s.name === "navigation")!.startTime).toEqual(observationTime(300))
  expect(spans.find(s => s.name === "navigation")!.endTime).toEqual(observationTime(900))
  await processor.shutdown()
})
