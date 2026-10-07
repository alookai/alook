import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { prepareCommunityImage } from "./image-thumbnail"
import { getCroppedIconBlob } from "./community/image-crop"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./observability/telemetry"

const images: HTMLImageElement[] = []
const events: Array<{ name: string; attributes: Record<string, string> }> = []
beforeEach(() => {
  images.length = 0; events.length = 0
  configureTelemetry({ session_id: "conversion-session" }, true); installTelemetrySink(event => events.push(event))
  const OriginalURL = URL
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => "blob:https://example.test/private"); static revokeObjectURL = vi.fn() })
  vi.stubGlobal("Image", function () { const image = document.createElement("img"); images.push(image); return image })
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["fixture"], { type: "image/jpeg" })))
})
afterEach(() => { retireTelemetry(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function loaded(width = 2000, height = 1000) {
  const image = images.at(-1)!
  Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } })
  await act(async () => { image.dispatchEvent(new Event("load")); await Promise.resolve() })
}
it("joins off-DOM preview loading and canvas encoding while preserving source revocation", async () => {
  const pending = prepareCommunityImage(new File(["fixture"], "private.png", { type: "image/png" }))
  await loaded()
  const result = await pending
  expect(result?.blob).toBeInstanceOf(Blob)
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  const phases = events.filter(event => event.name === "image.lifecycle")
  expect(phases.map(event => event.attributes.image_phase)).toEqual(["source_change", "load", "encode_start", "encode_ready"])
  expect(new Set(phases.map(event => event.attributes.image_instance_id)).size).toBe(1)
  expect(JSON.stringify(events)).not.toContain("private")
})
it("distinguishes crop load failure from null canvas encoding", async () => {
  const failed = getCroppedIconBlob("/private.png", { x: 0, y: 0, width: 10, height: 10 }, 20)
  const rejected = expect(failed).rejects.toBeInstanceOf(Event)
  images.at(-1)!.dispatchEvent(new Event("error")); await rejected
  expect(events.some(event => event.attributes.image_slot === "crop" && event.attributes.image_phase === "error")).toBe(true)
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => callback(null))
  const pending = getCroppedIconBlob("/private.png", { x: 0, y: 0, width: 10, height: 10 }, 20)
  await loaded(10, 10)
  expect(await pending).toBeNull()
  expect(events.at(-1)!.attributes).toMatchObject({ image_slot: "crop", image_phase: "encode_error" })
})
it("does not publish an old preparation's later load or encoding into a replacement session", async () => {
  const pending = prepareCommunityImage(new File(["fixture"], "private.png", { type: "image/png" }))
  retireTelemetry(); configureTelemetry({ session_id: "replacement-session" }, true); installTelemetrySink(event => events.push(event))
  const count = events.length
  await loaded()
  expect((await pending)?.blob).toBeInstanceOf(Blob)
  expect(events).toHaveLength(count)
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
})
