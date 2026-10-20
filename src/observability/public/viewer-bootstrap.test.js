import { afterEach, expect, it, vi } from "vitest"

vi.mock("./vendor/trace-waterfall-viewer/src/ui.js", () => ({ start: vi.fn(), loadText: vi.fn() }))
vi.mock("./viewer-adapter.js", () => ({ loadSelectedTrace: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it("wires the served bootstrap to the pinned public API and current selected trace", async () => {
  const { loadSelectedTrace } = await import("./viewer-adapter.js")
  const { start, loadText } = await import("./vendor/trace-waterfall-viewer/src/ui.js")
  const document = { body: {} }
  const location = { search: "?trace=" + "a".repeat(32) }
  const fetch = vi.fn()
  vi.stubGlobal("document", document)
  vi.stubGlobal("location", location)
  vi.stubGlobal("fetch", fetch)
  await import("./viewer-bootstrap.js")
  expect(loadSelectedTrace).toHaveBeenCalledWith({ document, search: location.search, fetch, start, loadText })
  expect(start).not.toHaveBeenCalled()
})
