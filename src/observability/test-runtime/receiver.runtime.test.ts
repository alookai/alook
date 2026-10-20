import { env } from "cloudflare:workers"
import { SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { database, persistBatch } from "../src/store"
import { getTrace, listLogs } from "../src/queries"
import { parseBatch } from "../src/otlp"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { batches, logs, spans } from "../src/schema"
import worker from "../src/index"
import { CHILD, logDocument, OTHER_TRACE, ROOT, span, TRACE, traceDocument } from "./fixtures"

const origin = "http://127.0.0.1:4318"
const ingest = (value: unknown, signal = "traces", headers = {}) => SELF.fetch(origin + "/v1/" + signal, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) })
const get = (path: string) => SELF.fetch(origin + path)
beforeEach(async () => { await env.DB.prepare("DELETE FROM batches").run() })

describe("local receiver with real D1", () => {
  it("rejects a leading UTF-8 BOM without silently normalizing or persisting any batch", async () => {
    const bytes = new TextEncoder().encode("\uFEFF" + JSON.stringify(traceDocument()))
    const response = await SELF.fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: bytes })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "Invalid OTLP JSON object" })
    expect(await env.DB.prepare("SELECT count(*) AS count FROM batches").first("count")).toBe(0)
  })

  it("keeps declared indexes and cascade ownership aligned with the applied migrations", async () => {
    for (const table of [spans, logs]) {
      const config = getTableConfig(table)
      expect(config.foreignKeys).toHaveLength(1)
      expect(config.foreignKeys[0].reference().foreignTable).toBe(batches)
      const actual = await env.DB.prepare(`PRAGMA foreign_key_list(${config.name})`).all<{ on_delete: string }>()
      expect(actual.results[0].on_delete).toBe("CASCADE")
      const indexes = await env.DB.prepare(`PRAGMA index_list(${config.name})`).all<{ name: string }>()
      for (const declared of config.indexes) expect(indexes.results.map(row => row.name)).toContain(declared.config.name)
    }
  })
  it("acknowledges persisted data and returns byte-exact original JSON separately from selected trace OTLP", async () => {
    const raw = JSON.stringify(traceDocument([span(), span({ traceId: OTHER_TRACE, spanId: CHILD })]), null, 2)
    const response = await SELF.fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:9540" }, body: raw })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:9540")
    const id = response.headers.get("x-alook-batch-id")!
    expect(await (await get("/api/batches/" + id)).text()).toBe(raw)
    const detail = await getTrace(database(env.DB), TRACE)
    expect(detail.spanCount).toBe(1)
    expect(JSON.stringify(detail.otlp)).not.toContain(OTHER_TRACE + '","spanId":"' + CHILD + '","name"')
    const selected = detail.otlp.resourceSpans[0]
    expect(selected.schemaUrl).toBe("resource-schema")
    expect(selected.resource).toMatchObject({ originalResource: true })
    expect(await (await get("/api/stats")).json()).toMatchObject({ batches: 1, spans: 2, logs: 0 })
  })

  it("merges out-of-order/incremental spans and replaces duplicate pointers without reviving obsolete records", async () => {
    await ingest(traceDocument([span({ spanId: CHILD, parentSpanId: ROOT, name: "child" }), span({ name: "obsolete" })]))
    await ingest(traceDocument([span({ name: "current" })]))
    const detail = await getTrace(database(env.DB), TRACE)
    expect(detail.spanCount).toBe(2)
    expect(JSON.stringify(detail.otlp)).toContain("current")
    expect(JSON.stringify(detail.otlp)).not.toContain("obsolete")
    expect(JSON.stringify(detail.otlp)).toContain('"parentSpanId":"' + ROOT + '"')
    const list = await (await get("/api/traces?page=page-1&session=session-1")).json() as { items: Array<{ durationNano: string; name: string }> }
    expect(list.items[0].durationNano).toBe("8625000000")
    expect(list.items[0].name).toBe("current")
    expect(await (await get("/api/traces?page=unrelated")).json()).toMatchObject({ items: [] })
  })

  it("keeps log provenance explicit, uncorrelated logs visible, and original numeric timestamps unchanged", async () => {
    const document = logDocument({ traceId: OTHER_TRACE })
    expect((await ingest(document, "logs")).status).toBe(200)
    await ingest(logDocument({ attributes: [], body: { stringValue: "<img src=x onerror=alert(1)>" } }), "logs")
    const correlated = await listLogs(database(env.DB), { trace: TRACE })
    expect(correlated.items).toHaveLength(1)
    expect(correlated.items[0]).toMatchObject({ traceId: OTHER_TRACE, customTraceId: TRACE })
    const detail = await (await get("/api/logs/" + encodeURIComponent(correlated.items[0].id))).json() as { record: { timeUnixNano: number } }
    expect(detail.record.timeUnixNano).toBe(1780000000000000000)
    expect((await listLogs(database(env.DB), {})).items).toHaveLength(2)
    expect((await listLogs(database(env.DB), { page: "missing" })).items).toHaveLength(0)
  })

  it("prunes raw batches and dependent indexes atomically while retaining current upserts", async () => {
    const db = database(env.DB)
    const retention = { retainedBytes: 1024 * 1024, retainedBatches: 1, retainedRecords: 2000 }
    const put = async (name: string) => { const raw = JSON.stringify(traceDocument([span({ name })])); return persistBatch(db, raw, raw.length, parseBatch(raw, "traces"), retention) }
    const old = await put("old")
    await put("new")
    expect((await getTrace(db, TRACE)).spanCount).toBe(1)
    expect(JSON.stringify((await getTrace(db, TRACE)).otlp)).toContain("new")
    expect((await get("/api/batches/" + old.id)).status).toBe(404)
    expect(await (await get("/api/stats")).json()).toMatchObject({ batches: 1, spans: 1 })
  })

  it("marks detail truncation by span count and original batch bytes", async () => {
    await ingest(traceDocument([span(), span({ spanId: CHILD })]))
    expect(await getTrace(database(env.DB), TRACE, { traceSpans: 1, traceBytes: 8 * 1024 * 1024 })).toMatchObject({ spanCount: 1, truncated: true, reasons: ["span limit"] })
    expect(await getTrace(database(env.DB), TRACE, { traceSpans: 5000, traceBytes: 1 })).toMatchObject({ spanCount: 0, truncated: true, reasons: ["source byte limit"] })
  })

  it("rolls back the original raw batch if an index statement fails", async () => {
    await env.DB.prepare("CREATE TRIGGER reject_span BEFORE INSERT ON spans BEGIN SELECT RAISE(ABORT, 'fixture index failure'); END").run()
    try {
      expect((await ingest(traceDocument())).status).toBe(500)
      expect(await (await get("/api/stats")).json()).toMatchObject({ batches: 0, spans: 0, logs: 0 })
    } finally { await env.DB.prepare("DROP TRIGGER reject_span").run() }
  })

  it("checks host/origin before reads and static assets, with ingest-only loopback CORS", async () => {
    expect((await SELF.fetch("http://evil.example/")).status).toBe(403)
    expect((await SELF.fetch(origin + "/app.js", { headers: { origin: "http://evil.example" } })).status).toBe(403)
    expect((await SELF.fetch(origin + "/api/stats", { headers: { origin: "http://localhost:9540" } })).status).toBe(403)
    expect((await SELF.fetch(origin + "/api/stats", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
    expect((await ingest(traceDocument(), "traces", { origin: "http://localhost.evil:9540" })).status).toBe(403)
    expect((await ingest(traceDocument(), "traces", { origin: "null" })).status).toBe(403)
    const preflight = await SELF.fetch(origin + "/v1/logs", { method: "OPTIONS", headers: { origin: "http://localhost:9540" } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("serves the adapted canonical viewer without redirecting past the single owned bootstrap", async () => {
    const home = await get("/")
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("Local observations")
    expect((await get("/app.test.js")).status).toBe(404)
    const response = await get("/viewer?trace=" + TRACE)
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    const html = await response.text()
    expect(html.match(/src="\/viewer-bootstrap.js"/g)).toHaveLength(1)
    expect(html).not.toContain("there is no server")
    expect(html).toContain('base href="/vendor/trace-waterfall-viewer/"')
  })

  it("preserves a missing viewer asset error instead of wrapping it as a working view", async () => {
    const assets = new Proxy(env.ASSETS, { get(target, key) { return key === "fetch" ? async () => new Response("missing fixture asset", { status: 404 }) : Reflect.get(target, key) } })
    const response = await worker.fetch(new Request(origin + "/viewer?trace=" + TRACE), { DB: env.DB, ASSETS: assets, LOCAL_RUN_ID: "fixture" })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("missing fixture asset")
  })

  it("returns explicit errors for invalid payloads, filters, methods and missing retained records", async () => {
    expect((await ingest({})).status).toBe(400)
    expect((await ingest(traceDocument(), "traces", { "content-type": "text/plain" })).status).toBe(415)
    expect((await get("/v1/traces")).status).toBe(405)
    expect((await SELF.fetch(origin + "/api/stats", { method: "POST" })).status).toBe(405)
    expect((await get("/api/logs?trace=invalid")).status).toBe(400)
    expect((await get("/api/traces?page=" + "a".repeat(129))).status).toBe(400)
    expect((await get("/api/unknown")).status).toBe(404)
    expect((await get("/api/traces/" + TRACE)).status).toBe(404)
    expect((await get("/api/logs/00000000-0000-0000-0000-000000000000:0")).status).toBe(404)
  })
})
