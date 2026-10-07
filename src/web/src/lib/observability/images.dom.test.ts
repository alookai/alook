import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { installImageObservers, observeImageResource } from "./images"
import { imageSourceId, imageCorrelationSnapshot } from "./image-correlation"
import { emitImageTelemetry } from "./image-event-budget"
import { configureTelemetry, installTelemetrySink, isTelemetryEligible, retireTelemetry } from "./telemetry"
import { cleanAttributes } from "./schema"

const events: Array<{ name: string; attributes: Record<string, string> }> = []
let stop: (() => void) | undefined
beforeEach(() => { events.length = 0; configureTelemetry({ session_id: "image-session", page_instance_id: "image-page" }, true); installTelemetrySink(event => events.push(event)) })
afterEach(() => { stop?.(); stop = undefined; retireTelemetry(); document.body.replaceChildren(); vi.useRealTimers() })
it("joins initial, replaced and srcset DOM nodes to resources without calling decode or exporting a URL", async () => {
  const one = document.createElement("img")
  one.src = "/api/community/users/private/avatar?v=3&token=private"
  document.body.append(one)
  stop = installImageObservers(isTelemetryEligible)
  const first = events.find(event => event.attributes.image_phase === "snapshot")!.attributes
  const two = document.createElement("img")
  two.src = one.src
  await act(async () => { one.replaceWith(two); await Promise.resolve() })
  const attached = events.find(event => event.attributes.image_phase === "attach")!.attributes
  expect(attached.image_node_id).not.toBe(first.image_node_id)
  expect(attached.image_source_id).toBe(first.image_source_id)
  expect(events.some(event => event.attributes.image_phase === "detach" && event.attributes.image_node_id === first.image_node_id)).toBe(true)
  Object.defineProperty(two, "currentSrc", { configurable: true, value: window.location.origin + "/private-selected.png" })
  await act(async () => { two.srcset = "/private-selected.png 2x"; await Promise.resolve() })
  const selected = events.find(event => event.attributes.image_phase === "source_change")!.attributes
  const resource = { name: two.currentSrc, fetchStart: 2, requestStart: 5002, responseStart: 5100, responseEnd: 5200, responseStatus: 0 } as PerformanceResourceTiming
  expect(cleanAttributes(observeImageResource(resource)).image_source_id).toBe(selected.image_source_id)
  expect(cleanAttributes(observeImageResource(resource))).toMatchObject({ fetch_start_ms: "2", request_start_ms: "5002", delivery_type: "unknown" })
  expect(cleanAttributes(observeImageResource(resource))).not.toHaveProperty("status")
  two.dispatchEvent(new Event("error"))
  const error = events.at(-1)!.attributes
  expect(error.image_phase).toBe("error")
  expect(error).not.toHaveProperty("status")
  expect(JSON.stringify(events)).not.toContain("private")
  expect(events.some(event => event.attributes.image_phase === "decode_start")).toBe(false)
})
it("records first Shift+F10 before its image transitions and stops at consent retirement", async () => {
  stop = installImageObservers(isTelemetryEligible)
  window.dispatchEvent(new KeyboardEvent("keydown", { shiftKey: true, key: "F10" }))
  const operation = events.at(-1)!.attributes
  expect(operation.operation_key).toBe("shift_f10")
  const image = document.createElement("img")
  await act(async () => { document.body.append(image); await Promise.resolve() })
  expect(events.at(-1)!.attributes.operation_sequence).toBe(operation.operation_sequence)
  const count = events.length
  retireTelemetry()
  image.dispatchEvent(new Event("load"))
  await act(async () => { image.remove(); await Promise.resolve() })
  expect(events).toHaveLength(count)
})
it("observes a fetched SVG image node while excluding local SVG paths and filters", async () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  const image = document.createElementNS(svg.namespaceURI, "image")
  const group = document.createElementNS(svg.namespaceURI, "g")
  const path = document.createElementNS(svg.namespaceURI, "path")
  image.setAttribute("href", "/alook.svg")
  group.append(image); svg.append(group, path); document.body.append(svg)
  stop = installImageObservers(isTelemetryEligible)
  expect(events.filter(event => event.name === "image.lifecycle")).toHaveLength(1)
  const snapshot = events[0]!.attributes
  expect(snapshot.image_element).toBe("svg_image")
  image.dispatchEvent(new Event("load"))
  expect(events.at(-1)!.attributes.image_node_id).toBe(snapshot.image_node_id)
  await act(async () => { image.setAttribute("href", "/official-server-badge-flat.svg"); await Promise.resolve() })
  expect(events.at(-1)!.attributes.image_phase).toBe("source_change")
  await act(async () => { group.remove(); await Promise.resolve() })
  expect(events.at(-1)!.attributes).toMatchObject({ image_phase: "detach", image_node_id: snapshot.image_node_id })
  const second = document.createElementNS(svg.namespaceURI, "svg")
  document.body.append(second)
  await act(async () => { second.append(group); await Promise.resolve() })
  expect(events.at(-1)!.attributes).toMatchObject({ image_phase: "attach", image_node_id: snapshot.image_node_id })
  const count = events.length
  await act(async () => { svg.append(group); await Promise.resolve() })
  expect(events.slice(count).map(event => event.attributes.image_phase)).toEqual(["detach", "attach"])
  expect(events.slice(count).every(event => event.attributes.image_node_id === snapshot.image_node_id)).toBe(true)
  expect(events.some(event => event.attributes.image_phase === "decode_ready")).toBe(false)
})
it("bounds source correlation and retires identifiers without retaining data URL payloads", () => {
  const id = imageSourceId("/same.png")
  for (let i = 0; i < 512; i++) imageSourceId(`/image-${i}.png`)
  expect(imageSourceId("/same.png")).not.toBe(id)
  expect(imageCorrelationSnapshot()).toEqual({ correlation_evictions: 2, correlation_size: 512 })
  expect(imageSourceId("data:image/png;base64," + "A".repeat(5000))).toBeUndefined()
  const current = imageSourceId("/same.png")
  retireTelemetry()
  expect(imageSourceId("/same.png")).not.toBe(current)
  expect(imageCorrelationSnapshot().correlation_evictions).toBe(0)
})
it("does not let non-image resources evict image joins and identifies a genuinely lost source correlation", () => {
  const id = imageSourceId("/slow.png")
  for (let i = 0; i < 600; i++) observeImageResource({ name: `/api/agents?index=${i}`, initiatorType: "fetch" } as PerformanceResourceTiming)
  expect(observeImageResource({ name: "/slow.png", initiatorType: "img" } as PerformanceResourceTiming).image_source_id).toBe(id)
  for (let i = 0; i < 512; i++) imageSourceId(`/other-${i}.png`)
  const late = observeImageResource({ name: "/slow.png", initiatorType: "img" } as PerformanceResourceTiming)
  expect(late.image_source_id).not.toBe(id)
  expect(Number(late.correlation_evictions)).toBeGreaterThan(0)
})
it("bounds live-sink bursts before allocating fields and reports diagnostic loss separately from image failure", async () => {
  vi.useFakeTimers()
  const fields = vi.fn(() => ({ image_phase: "load" }))
  for (let i = 0; i < 350; i++) emitImageTelemetry("image.lifecycle", fields)
  expect(events.filter(event => event.name === "image.lifecycle")).toHaveLength(200)
  expect(fields).toHaveBeenCalledTimes(200)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), image = document.createElementNS(svg.namespaceURI, "image")
  image.setAttribute("href", "/budget-skipped.svg"); svg.append(image); document.body.append(svg)
  const correlation = imageCorrelationSnapshot()
  stop = installImageObservers(isTelemetryEligible)
  expect(imageCorrelationSnapshot()).toEqual(correlation)
  await vi.advanceTimersByTimeAsync(1000)
  expect(events.find(event => event.name === "telemetry.drop")!.attributes).toMatchObject({ drop_reason: "image_rate_limit", drop_count: "151", capability: "limited" })
  emitImageTelemetry("image.lifecycle", fields)
  expect(fields).toHaveBeenCalledTimes(201)
  const count = events.length
  retireTelemetry()
  emitImageTelemetry("image.lifecycle", fields)
  expect(events).toHaveLength(count)
  expect(fields).toHaveBeenCalledTimes(201)
})
