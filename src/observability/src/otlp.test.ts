import { describe, expect, it } from "vitest"
import { LIMITS, readBody } from "./limits"
import { nanoKey, parseBatch, recordAt } from "./otlp"
import { attr, CHILD, logDocument, OTHER_TRACE, span, TRACE, traceDocument } from "../test-runtime/fixtures"

describe("official Faro OTLP indexing", () => {
  it("preserves native decimal nanoseconds, context, events, links and unknown original fields", () => {
    const document = traceDocument()
    const parsed = parseBatch(JSON.stringify(document), "traces")
    expect(parsed.document).toEqual(document)
    const row = parsed.spans[0]
    expect(BigInt(row.endNano) - BigInt(row.startNano)).toBe(8625000000n)
    expect(row).toMatchObject({ traceId: TRACE, pageInstanceId: "page-1", sessionId: "session-1", service: "alook-web" })
    expect(recordAt(parsed.document, "traces", row).record).toEqual(document.resourceSpans[0].scopeSpans[0].spans[0])
  })

  it("keeps the last duplicate pointer and indexes resources/scopes independently", () => {
    const document = traceDocument([span(), span({ name: "new" })])
    document.resourceSpans.push({ ...document.resourceSpans[0], scopeSpans: [{ ...document.resourceSpans[0].scopeSpans[0], spans: [span({ spanId: CHILD, traceId: OTHER_TRACE })] }] })
    const parsed = parseBatch(JSON.stringify(document), "traces")
    expect(parsed.records).toBe(3)
    expect(parsed.spans).toHaveLength(2)
    expect(parsed.spans[0]).toMatchObject({ name: "new", recordIndex: 1 })
    expect(parsed.spans[1]).toMatchObject({ resourceIndex: 1, traceId: OTHER_TRACE })
  })

  it("indexes actual nested event attributes without fabricating a native trace link", () => {
    const document = logDocument()
    const row = parseBatch(JSON.stringify(document), "logs").logs[0]
    expect(row).toMatchObject({ traceId: "", customTraceId: TRACE, pageInstanceId: "page-1", sessionId: "session-1", eventName: "navigation.ready" })
    expect(typeof document.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe("number")
    const conflict = parseBatch(JSON.stringify(logDocument({ traceId: OTHER_TRACE })), "logs").logs[0]
    expect(conflict).toMatchObject({ traceId: OTHER_TRACE, customTraceId: TRACE })
  })

  it("retains uncorrelated measurements and metadata references", () => {
    const row = parseBatch(JSON.stringify(logDocument({ attributes: [attr("measurement.name", "fcp"), attr("session.id", "sdk-session"), { key: "page.attributes", value: { kvlistValue: { values: [attr("page_instance_id", "meta-page")] } } }] })), "logs").logs[0]
    expect(row).toMatchObject({ traceId: "", customTraceId: "", eventName: "fcp", sessionId: "sdk-session", pageInstanceId: "meta-page" })
  })

  it("retains arbitrary custom attribute text without treating it as a native trace identifier", () => {
    const document = logDocument({ attributes: [{ key: "event.attributes", value: { kvlistValue: { values: [attr("trace_id", "unknown-reference")] } } }] })
    const parsed = parseBatch(JSON.stringify(document), "logs")
    expect(parsed.logs[0].customTraceId).toBe("")
    expect(parsed.document).toEqual(document)
  })

  it("keeps nested and array-valued attributes in the original context without inventing index fields", () => {
    const document = traceDocument([span({ attributes: [
      { key: "custom.array", value: { arrayValue: { values: [{ stringValue: "one" }, { intValue: "2" }, null] } } },
      { key: "custom.empty", value: { arrayValue: {} } },
      { key: "custom.null", value: {} },
      null, { key: 1, value: {} }, { key: "missing-value" },
    ] })])
    const parsed = parseBatch(JSON.stringify(document), "traces")
    expect(parsed.document).toEqual(document)
    expect(parsed.spans[0]).toMatchObject({ pageInstanceId: "", sessionId: "" })
  })

  it.each(["{", "[]", "null", "{}", '{"resourceSpans":{}}'])("rejects malformed JSON shape %s", raw => {
    expect(() => parseBatch(raw, "traces")).toThrow()
  })

  it.each([
    { traceId: "0".repeat(32) }, { spanId: "bad" }, { parentSpanId: "bad" },
    { startTimeUnixNano: "-1" }, { endTimeUnixNano: "18446744073709551616" }, { endTimeUnixNano: "0" },
  ])("rejects invalid trace fields %j", change => {
    expect(() => parseBatch(JSON.stringify(traceDocument([span(change)])), "traces")).toThrow()
  })

  it("enforces record bounds and preserves numeric timestamp limits", () => {
    expect(() => parseBatch(JSON.stringify(traceDocument(Array.from({ length: LIMITS.recordsPerRequest + 1 }, () => span()))), "traces")).toThrow("Too many")
    expect(nanoKey(1780000000000000000)).toBe("01780000000000000000")
    for (const bad of [NaN, Infinity, -1, 0.1, "bad", null]) expect(() => nanoKey(bad)).toThrow()
  })
})

describe("bounded UTF-8 request reading", () => {
  it("keeps a chunked leading BOM intact so strict JSON rejects it instead of silently changing raw bytes", async () => {
    const raw = "\uFEFF" + JSON.stringify(traceDocument())
    const bytes = new TextEncoder().encode(raw)
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1, 2)); controller.enqueue(bytes.slice(2)); controller.close() } })
    const request = new Request("http://localhost:4318", { method: "POST", body, duplex: "half" } as RequestInit)
    const received = await readBody(request)
    expect(received).toEqual({ raw, bytes: bytes.length })
    expect(() => parseBatch(received.raw, "traces")).toThrow("Invalid OTLP JSON")
  })

  it("accepts chunked Unicode and counts original bytes", async () => {
    const bytes = new TextEncoder().encode('{"label":"你好"}')
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); controller.close() } })
    const request = new Request("http://localhost:4318", { method: "POST", body, duplex: "half" } as RequestInit)
    expect(await readBody(request)).toEqual({ raw: '{"label":"你好"}', bytes: bytes.length })
  })

  it("rejects both advertised and streamed oversize bodies, and invalid UTF-8", async () => {
    await expect(readBody(new Request("http://localhost", { method: "POST", headers: { "content-length": String(LIMITS.requestBytes + 1) }, body: "{}" }))).rejects.toMatchObject({ status: 413 })
    await expect(readBody(new Request("http://localhost", { method: "POST", body: "a".repeat(LIMITS.requestBytes + 1) }))).rejects.toMatchObject({ status: 413 })
    await expect(readBody(new Request("http://localhost", { method: "POST", body: new Uint8Array([255]) }))).rejects.toThrow("UTF-8")
    await expect(readBody(new Request("http://localhost", { method: "POST" }))).rejects.toThrow("required")
  })
})
