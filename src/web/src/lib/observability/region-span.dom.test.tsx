import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { beginNavigation, clearActions, installActionSpans } from "./context"
import { configureTelemetry, retireTelemetry } from "./telemetry"
import { useObservedRegion } from "./regions"
import { observationTime } from "./clock"

afterEach(async () => { await act(async () => { retireTelemetry(); clearActions(); installActionSpans(undefined) }); vi.restoreAllMocks(); window.history.replaceState(null, "", "/") })
it("records only the visible component commit-to-ready wait as a native child without another action timer", async () => {
  let now = 100
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  configureTelemetry({ session_id: "chain-session" }, true)
  installActionSpans((name, attributes, startTime, links, parent) => provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT))
  const href = "/c/me/bots"
  window.history.replaceState(null, "", href)
  const action = beginNavigation(href)!
  const timer = vi.spyOn(globalThis, "setTimeout")
  function Component({ ready }: { ready: boolean }) { useObservedRegion("bots", ready, 1, { snapshot_source: "rsc", target_coverage: ready ? "covered" : "uncovered", wait_reason: ready ? "none" : "identity" }); return <p>{ready ? "ready" : "pending"}</p> }
  const view = render(<Component ready={false} />)
  expect(exporter.getFinishedSpans()).toEqual([])
  expect(timer).not.toHaveBeenCalled()
  now = 180
  await act(async () => view.rerender(<Component ready />))
  const child = exporter.getFinishedSpans().find(span => span.name === "region.wait")!
  expect(child.parentSpanContext).toEqual(action.span!.spanContext())
  expect(child.attributes).toMatchObject({ region: "bots", span_role: "region_readiness", phase: "commit", source: "unknown", snapshot_source: "rsc", target_coverage: "uncovered", wait_reason: "identity", outcome: "success" })
  expect(child.startTime).toEqual(observationTime(100, action.origin))
  expect(child.endTime).toEqual(observationTime(180, action.origin))
  expect(action.done).toBe(true)
  await provider.shutdown()
})
