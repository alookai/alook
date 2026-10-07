import React from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { RemoteContentImage, RemoteIdentityImage } from "./remote-image"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"

const events: Array<{ name: string; attributes: Record<string, string> }> = []
beforeEach(() => { events.length = 0; configureTelemetry({ session_id: "image-session" }, true); installTelemetrySink(event => events.push(event)) })
afterEach(() => { retireTelemetry(); vi.useRealTimers() })
function metrics(image: HTMLImageElement, decode: () => Promise<void>) { Object.defineProperties(image, { decode: { value: decode, configurable: true }, naturalWidth: { value: 320, configurable: true }, naturalHeight: { value: 200, configurable: true } }) }
it("attributes timeout, same-attempt parent replacement and ignored old-node decode while preserving failure behavior", async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const view = render(React.createElement(RemoteContentImage, { src: "/private-image.png", alt: "private caption", loading: "eager", onActivate: () => {}, timeoutMs: 50 }))
  const original = view.container.querySelector("img")!
  metrics(original, () => waiting)
  fireEvent.load(original)
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  const replacement = view.container.querySelector("img")!
  expect(replacement).not.toBe(original)
  expect(replacement.dataset.remoteImageState).toBe("error")
  await act(async () => { finish(); await waiting })
  const ready = events.find(event => event.attributes.image_phase === "decode_ready")!.attributes
  const ignored = events.find(event => event.attributes.image_phase === "ignored" && event.attributes.ignored_reason === "terminal")!.attributes
  expect(ready.current_node).toBe("false")
  expect(ignored.image_node_id).toBe(ready.image_node_id)
  expect(ignored.attempt).toBe("0")
  expect(events.filter(event => event.attributes.image_phase === "attach").map(event => event.attributes.image_parent)).toEqual(["button", "other"])
  expect(events.filter(event => event.attributes.image_phase === "attach").every(event => event.attributes.image_instance_id === ready.image_instance_id)).toBe(true)
  expect(replacement.dataset.remoteImageState).toBe("error")
  expect(JSON.stringify(events)).not.toContain("private")
  view.unmount()
})
it("separates Retry attempts and suppresses decode completions from a retired telemetry session", async () => {
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const view = render(React.createElement(RemoteIdentityImage, { src: "/private-avatar?v=1", alt: "private" }))
  const original = view.container.querySelector("img")!
  metrics(original, () => waiting)
  fireEvent.load(original)
  fireEvent.error(original)
  fireEvent(window, new Event("online"))
  expect(view.container.querySelector("img")).not.toBe(original)
  retireTelemetry(); configureTelemetry({ session_id: "replacement-session" }, true); installTelemetrySink(event => events.push(event))
  const count = events.length
  await act(async () => { finish(); await waiting })
  expect(events).toHaveLength(count)
  expect(view.container.querySelector("img")!.dataset.remoteImageState).toBe("pending")
  view.unmount()
})
it("reports the dimension fallback without claiming a decode API call", async () => {
  const view = render(React.createElement(RemoteIdentityImage, { src: "/fixture.png", alt: "fixture" }))
  const image = view.container.querySelector("img")!
  Object.defineProperties(image, { decode: { value: undefined, configurable: true }, naturalWidth: { value: 10, configurable: true }, naturalHeight: { value: 10, configurable: true } })
  fireEvent.load(image)
  await act(async () => { await Promise.resolve() })
  expect(image.dataset.remoteImageState).toBe("ready")
  expect(events.some(event => event.attributes.image_phase === "decode_start" || event.attributes.image_phase === "decode_ready")).toBe(false)
  expect(events.find(event => event.attributes.image_phase === "pixels_ready")!.attributes).toMatchObject({ decode_supported: "false", decode_called: "false" })
  view.unmount()
})
it("keeps an old readiness timer out of a replacement telemetry session while preserving its UI transition", async () => {
  vi.useFakeTimers()
  const view = render(React.createElement(RemoteIdentityImage, { src: "/fixture.png", alt: "fixture", timeoutMs: 50 }))
  retireTelemetry(); configureTelemetry({ session_id: "replacement-session" }, true); installTelemetrySink(event => events.push(event))
  events.length = 0
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(view.container.querySelector("img")!.dataset.remoteImageState).toBe("error")
  expect(events.some(event => ["timeout", "state", "timer_clear"].includes(event.attributes.image_phase))).toBe(false)
  view.unmount()
})
