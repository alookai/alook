import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { expect, it, vi } from "vitest"
import { createApp, formatDuration, formatTimestamp } from "./app.js"

const trace = "a".repeat(32)
const batch = "00000000-0000-0000-0000-000000000001"
function fixture() {
  const dom = new JSDOM(readFileSync(new URL("./index.html", import.meta.url), "utf8"), { url: "http://localhost:4318" })
  const fetch = vi.fn(async url => {
    if (url === "/api/stats") return Response.json({ spans: 3, logs: 2, rawBytes: 100, batches: 1, limits: { retainedBytes: 64 * 1024 * 1024, retainedBatches: 200 } })
    if (url.startsWith("/api/traces?")) return Response.json({ items: [{ traceId: trace, name: "<img src=x onerror=bad()>", service: "web", spanCount: 3, durationNano: "8625000000", startNano: "1780000000000000001" }], truncated: true })
    if (url === "/api/traces/" + trace) return Response.json({ spanCount: 3, truncated: false, sourceBatches: [{ id: batch }] })
    if (url === "/api/logs/" + batch + "%3A0") return Response.json({ index: { eventName: "navigation.ready", batchId: batch }, record: { text: "<script>bad()</script>" } })
    return Response.json({ items: [{ id: batch + ":0", eventName: "navigation.ready", summary: "<img src=x onerror=bad()>", traceId: "", customTraceId: trace }], truncated: false })
  })
  return { dom, fetch, app: createApp({ document: dom.window.document, fetch }) }
}

it("renders received traces safely, retains the selected waterfall on list refresh, and labels original batches", async () => {
  const { dom, app } = fixture()
  const document = dom.window.document
  await app.refresh()
  expect(document.querySelector("#items").textContent).toContain("8.625 s extent")
  expect(document.querySelector("#list-status").textContent).toContain("First 100")
  expect(document.querySelector("#items img")).toBeNull()
  await app.selectTrace(trace)
  const frame = document.querySelector("iframe")
  expect(frame.src).toContain("/viewer?trace=" + trace)
  expect(document.querySelector("#selection a").textContent).toBe("Download original received batch")
  expect(document.querySelector("#selection").textContent).toContain("explicit event trace")
  await app.refresh()
  expect(document.querySelector("iframe")).toBe(frame)
  await app.selectLog(batch + ":0")
  expect(document.querySelector("pre").textContent).toContain("<script>bad()</script>")
  expect(document.querySelector("#selection script")).toBeNull()
  dom.window.close()
})

it("queries exact page/session filters and shows uncorrelated logs and request errors", async () => {
  const { dom, app, fetch } = fixture()
  const document = dom.window.document
  document.querySelector('[name="page"]').value = "page id"
  document.querySelector('[name="session"]').value = "session"
  await app.refresh()
  expect(fetch.mock.calls.some(([url]) => url === "/api/traces?page=page+id&session=session")).toBe(true)
  document.getElementById("logs-tab").click()
  await vi.waitFor(() => expect(document.querySelector("#items").textContent).toContain("navigation.ready"))
  expect(document.getElementById("logs-tab").getAttribute("aria-pressed")).toBe("true")
  fetch.mockImplementation(async () => new Response(null, { status: 500 }))
  await app.refresh()
  expect(document.getElementById("error").textContent).toContain("500")
  expect(document.getElementById("refresh").disabled).toBe(false)
  dom.window.close()
})

it("formats elapsed trace extents without subtracting large floating timestamps", () => {
  expect(formatDuration("169000000")).toBe("169 ms")
  expect(formatDuration("8625000000")).toBe("8.625 s")
  expect(formatDuration("3000")).toBe("0.003 ms")
  expect(formatTimestamp("1780000000000000001")).toBe("2026-05-28 20:26:40.000 UTC")
})

it("reports trace/log detail failures without treating a successful list as successful detail", async () => {
  const { dom, app, fetch } = fixture()
  await app.refresh()
  fetch.mockImplementation(async () => new Response(null, { status: 500 }))
  await app.selectTrace(trace)
  expect(dom.window.document.getElementById("error").textContent).toContain("500")
  await app.selectLog(batch + ":0")
  expect(dom.window.document.getElementById("error").textContent).toContain("500")
  dom.window.close()
})
