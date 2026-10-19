import { expect, it } from "vitest"
import { readTraceResponse, responseTraceContext, traceResponse } from "./trace-response"

const client = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }
const server = { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }
const request = () => new Request("https://alook.ai/api/community/bots", { headers: { traceparent: `00-${client.traceId}-${client.spanId}-01`, authorization: "private-token" } })

it("preserves the original stream, status and cache headers and uses only actual native server identity", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("body")); controller.close() } })
  const original = new Response(stream, { status: 202, headers: { "cache-control": "no-store", "server-timing": 'db;dur=2;desc="a,b"' } })
  const response = traceResponse(original, request(), { isTraced: true, spanContext: () => server })
  expect(response.body).toBe(original.body)
  expect(response.status).toBe(202)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const header = response.headers.get("server-timing")!
  expect(header).toContain('db;dur=2;desc="a,b"')
  expect(header).not.toContain("private-token")
  expect(header).not.toContain("/api/community/bots")
  expect(readTraceResponse(header, client)).toEqual({ matched: true, server, sampling: "selected" })
  expect(await response.text()).toBe("body")
})

it("separates sampler selection from getter availability and never substitutes upstream identity", () => {
  for (const isTraced of [true, false]) {
    const response = traceResponse(new Response(), request(), { isTraced })
    expect(readTraceResponse(response.headers.get("server-timing")!, client)).toEqual({ matched: true, server: undefined, sampling: isTraced ? "selected" : "not_selected" })
    expect(response.headers.get("server-timing")).not.toContain("traceparent;")
  }
  for (const getter of [() => ({ ...server, traceId: "0".repeat(32) }), () => { throw new Error("missing runtime capability") }]) {
    const response = traceResponse(new Response(), request(), { isTraced: true, spanContext: getter })
    expect(readTraceResponse(response.headers.get("server-timing")!, client).server).toBeUndefined()
  }
  expect(traceResponse(Response.error(), request()).status).toBe(0)
})

it("rejects zero, malformed, missing, repeated and stale response identities", () => {
  const header = traceResponse(new Response(), request(), { isTraced: true, spanContext: () => server }).headers.get("server-timing")!
  for (const value of ["", header + `, alook_upstream;desc="${client.traceId}-${client.spanId}"`, header.replace(client.spanId, "e".repeat(16))]) {
    expect(readTraceResponse(value, client)).toEqual({ matched: false, server: undefined, sampling: "unavailable" })
  }
  for (const value of [null, "00-" + "0".repeat(32) + "-" + client.spanId + "-01", "ff-" + client.traceId + "-" + client.spanId + "-01"]) expect(responseTraceContext(value)).toBeUndefined()
})
