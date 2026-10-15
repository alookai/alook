import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { recordDocumentTiming } from "./document-timing"

afterEach(() => vi.restoreAllMocks())

it.each(["selected", "not_selected"])("links the exact document server identity while retaining its %s sampling state", async sampling => {
  const server = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: sampling === "selected" ? 1 : 0 }
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{
    responseEnd: 18,
    serverTiming: [
      { name: "alook_server", description: `00-${server.traceId}-${server.spanId}-0${server.traceFlags}` },
      { name: "alook_sampling", description: sampling },
    ],
  } as unknown as PerformanceEntry])
  const exporter = new InMemorySpanExporter()
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const span = provider.getTracer("alook.frontend").startSpan("navigation")
  recordDocumentTiming(span, 100_000, 50)
  span.end()
  const recorded = exporter.getFinishedSpans()[0]!
  expect(recorded.attributes).toMatchObject({ server_identity: "available", server_sampling: sampling, server_trace_id: server.traceId, server_span_id: server.spanId })
  expect(recorded.links).toEqual([{ context: server, attributes: { relationship: "document_response" } }])
  expect(recorded.parentSpanContext).toBeUndefined()
  await provider.shutdown()
})

it.each(["invalid", "duplicate"])("does not create a server link from %s document identity", async kind => {
  const identity = { name: "alook_server", description: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{
    serverTiming: kind === "duplicate" ? [identity, identity] : [{ ...identity, description: "invalid" }],
  } as unknown as PerformanceEntry])
  const exporter = new InMemorySpanExporter()
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const span = provider.getTracer("alook.frontend").startSpan("navigation")
  recordDocumentTiming(span, 100_000, 50)
  span.end()
  const recorded = exporter.getFinishedSpans()[0]!
  expect(recorded.attributes).toMatchObject({ server_identity: "unavailable", server_sampling: "unavailable" })
  expect(recorded.attributes).not.toHaveProperty("server_trace_id")
  expect(recorded.links).toEqual([])
  await provider.shutdown()
})
