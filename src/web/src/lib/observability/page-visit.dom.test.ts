import { ROOT_CONTEXT, SpanKind, context, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { beginNavigation, clearActions, commitNavigation, currentPageObservation, finishAction, installActionSpans, startAction, startPageOperation, finishPageOperation, startRegionObservation, finishRegionObservation, runPageOperation } from "./context"
import { configureTelemetry, retireTelemetry } from "./telemetry"
import { startRequest, runObservedFetch } from "./requests"
import { recordDocumentTiming } from "./document-timing"
import { observationTime } from "./clock"
import { observeRestoreRead, observeRestoreDecode, observeHydration } from "./restore"

const nativeProviders: WebTracerProvider[] = []
function nativeObservation() {
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  nativeProviders.push(provider)
  provider.register()
  configureTelemetry({ session_id: "captured-owner" }, true)
  installActionSpans((name, attributes, startTime, links, parent) => provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT))
  return exporter
}
function committedVisit(href: string) {
  window.history.replaceState(null, "", href)
  const owner = beginNavigation(href, "document")!
  commitNavigation(href)
  finishAction(owner, "success", { phase: "primary", region: "page" })
  return owner
}

afterEach(async () => { await act(async () => { retireTelemetry(); clearActions(); installActionSpans(undefined) }); await Promise.all(nativeProviders.splice(0).map(provider => provider.shutdown())); context.disable(); trace.disable(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/") })

it("runs business work on its captured page when operation tracing throws", () => {
  nativeObservation()
  const owner = committedVisit("/c/me/bots")
  installActionSpans(() => { throw new Error("tracer unavailable") })
  const operation = startPageOperation("cache.restore", { phase: "idb_read" }, owner)!
  const execute = vi.fn(() => "restored")
  expect(operation.span).toBeUndefined()
  expect(operation.page).toBe(owner)
  expect(runPageOperation(operation, execute)).toBe("restored")
  finishPageOperation(operation, "hit")
  expect(execute).toHaveBeenCalledOnce()
  expect(operation.done).toBe(true)
  expect(operation.outcome).toBe("hit")
})

it.each(["ws.connect", "cache.restore", "ui.interaction"] as const)("keeps a captured absent owner absent across a later visit for %s", async name => {
  const exporter = nativeObservation()
  const owner = currentPageObservation()
  expect(owner).toBeUndefined()
  await Promise.resolve()
  committedVisit("/c/me/bots")
  const operation = startPageOperation(name, {}, owner)
  finishPageOperation(operation, "success")
  expect(operation).toBeUndefined()
  expect(exporter.getFinishedSpans().map(span => span.name)).toEqual(["navigation"])
})

it.each(["ws.connect", "cache.restore", "ui.interaction"] as const)("keeps the captured old owner for %s after a new page commits", async name => {
  const exporter = nativeObservation()
  const owner = committedVisit("/c/me/bots")
  await Promise.resolve()
  const newer = committedVisit("/c/me/machines")
  const operation = startPageOperation(name, {}, owner)!
  finishPageOperation(operation, "success")
  const span = exporter.getFinishedSpans().find(span => span.name === name)!
  expect(operation.page).toBe(owner)
  expect(span.parentSpanContext).toEqual(owner.span!.spanContext())
  expect(span.spanContext().traceId).not.toBe(newer.span!.spanContext().traceId)
})

it.each(["ws.connect", "cache.restore", "ui.interaction"] as const)("rejects a retired captured owner for %s instead of using the new session page", async name => {
  const exporter = nativeObservation()
  const owner = committedVisit("/c/me/bots")
  retireTelemetry(); clearActions(); configureTelemetry({ session_id: "replacement-owner" }, true)
  committedVisit("/c/me/machines")
  const operation = startPageOperation(name, {}, owner)
  finishPageOperation(operation, "success")
  expect(operation).toBeUndefined()
  expect(exporter.getFinishedSpans().map(span => span.name)).toEqual(["navigation", "navigation"])
})

it("keeps an ownerless restore read, decode and hydration ownerless after a page commits", async () => {
  const exporter = nativeObservation()
  const persister = {}
  const snapshot = { timestamp: Date.now(), buster: "captured", clientState: { queries: [], mutations: [] } }
  let complete!: (value: typeof snapshot) => void
  const pending = observeRestoreRead(() => new Promise<typeof snapshot>(resolve => { complete = resolve }), persister)
  committedVisit("/c/me/bots")
  complete(snapshot)
  expect(await pending).toBe(snapshot)
  expect(observeRestoreDecode(persister, () => snapshot, "captured", 10_000)).toBe(snapshot)
  observeHydration(persister)
  expect(exporter.getFinishedSpans().map(span => span.name)).toEqual(["navigation"])
})

it("keeps post-ready commands and their requests on the visited page, captures old owners and replaces them only at a real visit commit", async () => {
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  provider.register()
  configureTelemetry({ session_id: "visit-session" }, true)
  installActionSpans((name, attributes, startTime, links, parent) => provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT))
  const a = "/c/me/bots", b = "/c/me/machines"
  window.history.replaceState(null, "", a)
  const pageA = beginNavigation(a, "document")!
  finishAction(pageA, "success", { phase: "primary", region: "bots" })
  const loadEnd = exporter.getFinishedSpans().find(s => s.name === "navigation")!.endTime
  expect(currentPageObservation()).toBe(pageA)
  const command = startAction("message.edit")!
  const pending = startRequest("/api/agents", { observation: { action: command, reason: "command" } })!
  const pageB = beginNavigation(b)!
  expect(currentPageObservation()).toBe(pageA)
  window.history.pushState(null, "", b)
  expect(currentPageObservation()).toBeUndefined()
  commitNavigation(b)
  finishAction(pageB, "success", { phase: "primary", region: "machines" })
  const http = runObservedFetch(pending, () => provider.getTracer("@opentelemetry/instrumentation-fetch").startSpan("GET", { kind: SpanKind.CLIENT }))
  http.end(); finishAction(command, "success")
  const ws = startPageOperation("ws.event_applied", { phase: "commit", source: "ws" }, currentPageObservation())!
  finishPageOperation(ws, "success")
  const spans = exporter.getFinishedSpans(), child = spans.find(s => s.spanContext().spanId === command.span!.spanContext().spanId)!
  expect(child.parentSpanContext).toEqual(pageA.span!.spanContext())
  expect(child.spanContext().traceId).toBe(pageA.span!.spanContext().traceId)
  expect(spans.find(s => s.spanContext().spanId === http.spanContext().spanId)!.parentSpanContext).toEqual(command.span!.spanContext())
  expect(pageB.span!.spanContext().traceId).not.toBe(pageA.span!.spanContext().traceId)
  expect(spans.find(s => s.name === "ws.event_applied")!.parentSpanContext).toEqual(pageB.span!.spanContext())
  expect(spans.find(s => s.spanContext().spanId === pageA.span!.spanContext().spanId)!.endTime).toEqual(loadEnd)
  retireTelemetry(); clearActions(); configureTelemetry({ session_id: "new-session" }, true)
  expect(currentPageObservation()).toBeUndefined()
  expect(startPageOperation("ws.connect", {}, currentPageObservation())).toBeUndefined()
  await provider.shutdown()
})

it("adds only actual original-document markers and leaves later DOM work outside its ready interval", () => {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ domInteractive: 20, domContentLoadedEventStart: 21, domContentLoadedEventEnd: 22, domComplete: 70, loadEventStart: 75, loadEventEnd: 80, responseEnd: 18, serverTiming: [] } as unknown as PerformanceEntry])
  const provider = new WebTracerProvider(), span = provider.getTracer("alook.frontend").startSpan("navigation")
  const event = vi.spyOn(span, "addEvent"), attribute = vi.spyOn(span, "setAttribute")
  recordDocumentTiming(span, 100_000, 50)
  expect(event.mock.calls.map(([name]) => name)).toEqual(["responseEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd"])
  expect(attribute).toHaveBeenCalledWith("document_timing", "partial")
  expect(attribute).toHaveBeenCalledWith("server_identity", "unavailable")
  span.end()
})

it("retains early component, cache and WS intervals through the original deferred set, and clears retired owners", async () => {
  let now = 10
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  configureTelemetry({ session_id: "early-visit" }, true)
  window.history.replaceState(null, "", "/c/me/bots")
  const page = beginNavigation(window.location.href, "document")!
  const region = startRegionObservation(page, "bots")!
  const restore = startPageOperation("cache.restore", { phase: "idb_read", cache_stage: "idb" }, currentPageObservation())!
  now = 25
  finishRegionObservation(region, page, "success")
  finishPageOperation(restore, "hit")
  finishAction(page, "success", { phase: "primary", region: "bots" })
  now = 30
  const ws = startPageOperation("ws.connect", { phase: "transport" }, currentPageObservation())!
  now = 40
  finishPageOperation(ws, "success")
  const factory = vi.fn((...args: Parameters<NonNullable<Parameters<typeof installActionSpans>[0]>>) => {
    const [name, attributes, startTime, links, parent] = args
    return provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT)
  })
  installActionSpans(factory)
  const spans = exporter.getFinishedSpans()
  expect(spans.map(span => span.name)).toEqual(["navigation", "region.wait", "cache.restore", "ws.connect"])
  for (const operation of [region, restore, ws]) {
    const span = spans.find(span => span.spanContext().spanId === operation.span!.spanContext().spanId)!
    expect(span.parentSpanContext).toEqual(page.span!.spanContext())
    expect(span.startTime).toEqual(observationTime(operation.start, page.origin))
    expect(span.endTime).toEqual(observationTime(operation.end!, page.origin))
  }
  expect(spans[0]!.endTime).toEqual(observationTime(25, page.origin))
  installActionSpans(undefined)
  const retired = startPageOperation("cache.restore", {}, currentPageObservation())!
  retireTelemetry(); clearActions(); configureTelemetry({ session_id: "later-visit" }, true)
  finishPageOperation(retired, "hit")
  factory.mockClear(); installActionSpans(factory)
  expect(factory).not.toHaveBeenCalled()
  expect(retired.span).toBeUndefined()
  await provider.shutdown()
})
