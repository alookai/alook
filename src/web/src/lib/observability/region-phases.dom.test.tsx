import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { beginNavigation, clearActions, installActionSpans } from "./context"
import { configureTelemetry, retireTelemetry } from "./telemetry"
import { ObservedRegionVisibility, useObservedRegion, type ResourceObservation } from "./regions"

afterEach(() => { retireTelemetry(); clearActions(); installActionSpans(undefined); vi.restoreAllMocks(); window.history.replaceState(null, "", "/") })

it("records actual condition intervals and closes ready, hidden and unmounted waits with explicit reasons", async () => {
  let now = 100
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const exporter = new InMemorySpanExporter(), provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  configureTelemetry({ session_id: "region-phases" }, true)
  installActionSpans((name, attributes, startTime, links, parent) => provider.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT))
  window.history.replaceState(null, "", "/c/me/bots")
  beginNavigation(window.location.href)
  function Probe({ reason, ready = false }: { reason: ResourceObservation["wait_reason"]; ready?: boolean }) {
    useObservedRegion("bots", ready, 1, { wait_reason: reason, snapshot_source: "network", target_coverage: reason === "entry" ? "uncovered" : "covered" })
    return <p>Content</p>
  }
  const view = render(<Probe reason="entry" />)
  now = 150
  await act(async () => view.rerender(<Probe reason="window" />))
  now = 180
  await act(async () => view.rerender(<Probe reason="projection" />))
  now = 190
  await act(async () => view.rerender(<Probe reason="virtual_window" />))
  now = 220
  await act(async () => view.rerender(<Probe reason="none" ready />))
  const spans = exporter.getFinishedSpans().filter(span => span.name === "region.wait")
  expect(spans.map(span => [span.attributes.wait_reason, span.attributes.release_reason, span.attributes.outcome])).toEqual([
    ["entry", "condition_changed", "superseded"], ["window", "condition_changed", "superseded"], ["projection", "condition_changed", "superseded"], ["virtual_window", "ready", "success"],
  ])
  expect(spans.map(span => (span.duration[0] * 1e9 + span.duration[1]) / 1e6)).toEqual([50, 30, 10, 30])
  await act(async () => { beginNavigation(window.location.href); view.rerender(<ObservedRegionVisibility visible><Probe reason="entry" /></ObservedRegionVisibility>) })
  now = 240
  await act(async () => view.rerender(<ObservedRegionVisibility visible={false}><Probe reason="entry" /></ObservedRegionVisibility>))
  expect(exporter.getFinishedSpans().filter(span => span.name === "region.wait").at(-1)?.attributes).toMatchObject({ release_reason: "hidden", outcome: "cancelled" })
  await act(async () => view.rerender(<ObservedRegionVisibility visible><Probe reason="window" /></ObservedRegionVisibility>))
  now = 250
  await act(async () => view.unmount())
  expect(exporter.getFinishedSpans().filter(span => span.name === "region.wait").at(-1)?.attributes).toMatchObject({ release_reason: "unmounted", outcome: "cancelled" })
  await provider.shutdown()
})
