import { JSDOM } from "jsdom"
import { expect, it, vi } from "vitest"
import { loadSelectedTrace } from "./viewer-adapter.js"

function fixture() {
  const dom = new JSDOM('<body><main id="app" hidden></main><div id="welcome"></div></body>')
  const document = dom.window.document
  const start = vi.fn()
  const loadText = vi.fn(() => { document.getElementById("app").hidden = false; document.getElementById("welcome").hidden = true })
  const fetch = vi.fn(async () => Response.json({ spanCount: 1, truncated: false, reasons: [], otlp: { resourceSpans: [] } }))
  return { dom, document, start, loadText, fetch, search: "?trace=" + "a".repeat(32) }
}

it("starts the public vendor API once and renders only the selected trace response", async () => {
  const value = fixture()
  await loadSelectedTrace(value)
  expect(value.start).toHaveBeenCalledTimes(1)
  expect(value.fetch).toHaveBeenCalledWith("/api/traces/" + "a".repeat(32), { credentials: "omit" })
  expect(value.loadText.mock.calls[0][0]).toBe('{"resourceSpans":[]}')
  expect(value.document.querySelector('[role="status"]').dataset.state).toBe("ready")
  value.dom.window.close()
})

it("reports swallowed vendor parse errors and failed receiver reads instead of a false render success", async () => {
  const value = fixture()
  value.loadText.mockImplementation(() => {})
  await loadSelectedTrace(value)
  expect(value.document.querySelector('[role="status"]').textContent).toContain("could not render")
  value.fetch.mockImplementation(async () => new Response(null, { status: 404 }))
  await loadSelectedTrace(value)
  expect(value.document.querySelector('[role="status"]').textContent).toContain("404")
  value.dom.window.close()
})

it("makes truncation and missing selection visible", async () => {
  const value = fixture()
  value.fetch.mockImplementation(async () => Response.json({ spanCount: 1, truncated: true, reasons: ["span limit"], otlp: {} }))
  await loadSelectedTrace(value)
  expect(value.document.querySelector('[role="status"]').textContent).toContain("Partial view: span limit")
  await loadSelectedTrace({ ...value, search: "" })
  expect(value.document.querySelector('[role="status"]').textContent).toContain("Select a retained trace")
  value.dom.window.close()
})
