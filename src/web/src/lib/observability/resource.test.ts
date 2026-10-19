import { ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { ObservationClockProcessor } from "./clock-tracing"
import { finishTransportClock, observationOrigin, observationTime } from "./clock"
import { observeResourceResponse } from "./resource"
import { traceResponse } from "./trace-response"

afterEach(() => { vi.restoreAllMocks() })
it.each([true, false])("links the exact response server identity without replacing the browser parent when sampled=%s", async sampled => {
  const exporter = new InMemorySpanExporter()
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const tracer = provider.getTracer("alook.frontend")
  const root = tracer.startSpan("navigation")
  const span = tracer.startSpan("GET", { kind: SpanKind.CLIENT }, trace.setSpan(ROOT_CONTEXT, root))
  const client = span.spanContext()
  const server = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: sampled ? 1 : 0 }
  const response = traceResponse(new Response(), new Request("https://alook.ai/api/community/bots", { headers: { traceparent: `00-${client.traceId}-${client.spanId}-01` } }), { isTraced: sampled, spanContext: () => server })
  observeResourceResponse(span, response.headers.get("server-timing")!)
  span.end()
  const recorded = exporter.getFinishedSpans()[0]!
  expect(recorded.attributes).toMatchObject({ server_identity: "available", server_sampling: sampled ? "selected" : "not_selected", server_trace_id: server.traceId, server_span_id: server.spanId })
  expect(recorded.links).toEqual([{ context: server, attributes: { relationship: "server_response" } }])
  expect(recorded.parentSpanContext).toEqual(root.spanContext())
  root.end()
  await provider.shutdown()
})

it("projects exact native resources for reversed same-URL requests and retains original parents, links and clocks", async () => {
  vi.spyOn(Date, "now").mockReturnValue(100_000)
  let now = 100
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const origin = observationOrigin()
  const entries: PerformanceEntry[] = []
  vi.spyOn(performance, "getEntriesByType").mockImplementation(() => entries)
  const exporter = new InMemorySpanExporter(), processor = new ObservationClockProcessor(new SimpleSpanProcessor(exporter))
  const provider = new WebTracerProvider({ spanProcessors: [processor] })
  const root = provider.getTracer("alook.frontend").startSpan("navigation")
  const tracer = provider.getTracer("@opentelemetry/instrumentation-fetch", "0.222.0")
  const make = () => tracer.startSpan("GET", { kind: SpanKind.CLIENT, links: [{ context: root.spanContext(), attributes: { relationship: "prefetch" } }] }, trace.setSpan(ROOT_CONTEXT, root))
  const one = make(), two = make()
  const record = (span: typeof one, responseEnd: number) => {
    const id = span.spanContext()
    const response = traceResponse(new Response(), new Request("https://alook.ai/api/community/bots", { headers: { traceparent: `00-${id.traceId}-${id.spanId}-01` } }), { isTraced: true })
    observeResourceResponse(span, response.headers.get("server-timing")!)
    entries.push({ name: "https://alook.ai/api/community/bots", entryType: "resource", serverTiming: [{ name: "alook_upstream", description: id.traceId + "-" + id.spanId }], fetchStart: 100, requestStart: 105, responseStart: responseEnd - 1, responseEnd, transferSize: 50, encodedBodySize: 30, decodedBodySize: 80, responseStatus: 200, nextHopProtocol: "h2", initiatorType: "fetch" } as unknown as PerformanceEntry)
  }
  record(two, 120); now = 120; finishTransportClock(two); two.end()
  record(one, 180); now = 180; finishTransportClock(one); one.end()
  const spans = exporter.getFinishedSpans()
  expect(spans.map(s => s.spanContext().spanId)).toEqual([two.spanContext().spanId, one.spanContext().spanId])
  for (const [span, end] of [[spans[0]!, 120], [spans[1]!, 180]] as const) {
    expect(span.attributes).toMatchObject({ resource_status: "matched", cache_hit_status: "fullLoad", clock_domain: "browser", clock_alignment: "unverified" })
    expect(span.events.find(e => e.name === "responseEnd")?.time).toEqual(observationTime(end, origin))
    expect(span.parentSpanContext).toEqual(root.spanContext())
    expect(span.links[0]?.attributes).toEqual({ relationship: "prefetch" })
  }
  root.end(); await provider.shutdown()
})

it("drops guessed network events when cache reuse gives duplicate or absent exact identities", async () => {
  const entries: PerformanceEntry[] = []
  vi.spyOn(performance, "getEntriesByType").mockImplementation(() => entries)
  const exporter = new InMemorySpanExporter(), processor = new ObservationClockProcessor(new SimpleSpanProcessor(exporter))
  const provider = new WebTracerProvider({ spanProcessors: [processor] }), tracer = provider.getTracer("@opentelemetry/instrumentation-fetch")
  const first = tracer.startSpan("GET", { kind: SpanKind.CLIENT }), fresh = tracer.startSpan("GET", { kind: SpanKind.CLIENT })
  const id = first.spanContext(), marker = `alook_upstream;desc="${id.traceId}-${id.spanId}", alook_sampling;desc="selected"`
  observeResourceResponse(first, marker)
  entries.push(...[1, 2].map(() => ({ entryType: "resource", serverTiming: [{ name: "alook_upstream", description: id.traceId + "-" + id.spanId }] } as unknown as PerformanceEntry)))
  first.addEvent("responseEnd"); finishTransportClock(first); first.end()
  const next = fresh.spanContext()
  observeResourceResponse(fresh, marker.replace(id.traceId, next.traceId).replace(id.spanId, next.spanId))
  fresh.addEvent("responseEnd"); finishTransportClock(fresh); fresh.end()
  const spans = exporter.getFinishedSpans()
  expect(spans.map(s => s.attributes.resource_status)).toEqual(["ambiguous", "missing"])
  expect(spans.map(s => s.events)).toEqual([[], []])
  expect(spans.map(s => s.droppedEventsCount)).toEqual([1, 1])
  await provider.shutdown()
})
