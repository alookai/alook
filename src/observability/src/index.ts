import { InputError, readBody } from "./limits"
import { parseBatch, traceId } from "./otlp"
import { getBatch, getLog, getTrace, listLogs, listTraces, statistics, type Filters } from "./queries"
import { database, persistBatch } from "./store"

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
function localOrigin(origin: string) {
  try {
    const url = new URL(origin)
    return ["http:", "https:"].includes(url.protocol) && loopback.has(url.hostname) && url.origin === origin
  } catch { return false }
}

function json(value: unknown, status = 200, headers?: HeadersInit) {
  const response = Response.json(value, { status, headers })
  response.headers.set("cache-control", "no-store")
  return response
}

function filters(url: URL): Filters {
  const page = url.searchParams.get("page") || undefined
  const session = url.searchParams.get("session") || undefined
  const trace = url.searchParams.get("trace") || undefined
  if ((page?.length ?? 0) > 128 || (session?.length ?? 0) > 128) throw new InputError("Filter exceeds 128 characters")
  return { page, session, trace: trace ? traceId(trace) : undefined }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")
    const ingest = url.pathname === "/v1/traces" || url.pathname === "/v1/logs"
    if (!loopback.has(url.hostname)) return json({ error: "Loopback host required" }, 403)
    if (origin && (!localOrigin(origin) || (!ingest && origin !== url.origin))) return json({ error: "Origin is not allowed" }, 403)
    if (!ingest && request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Same-origin read required" }, 403)
    const cors = new Headers()
    if (ingest && origin) {
      cors.set("access-control-allow-origin", origin)
      cors.set("vary", "Origin")
      cors.set("access-control-allow-methods", "POST, OPTIONS")
      cors.set("access-control-allow-headers", "content-type")
    }
    try {
      if (ingest) {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
        if (request.method !== "POST") return json({ error: "POST required" }, 405, cors)
        if (request.headers.get("content-encoding") || !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new InputError("OTLP JSON is required", 415)
        const { raw, bytes } = await readBody(request)
        const parsed = parseBatch(raw, url.pathname === "/v1/traces" ? "traces" : "logs")
        const receipt = await persistBatch(database(env.DB), raw, bytes, parsed)
        cors.set("x-alook-batch-id", receipt.id)
        return json({}, 200, cors)
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET required" }, 405)
      if (url.pathname === "/health") return json({ service: "alook-observability", schema: 1, runId: env.LOCAL_RUN_ID })
      const db = database(env.DB)
      if (url.pathname === "/api/stats") return json(await statistics(db))
      if (url.pathname === "/api/traces") return json(await listTraces(db, filters(url)))
      if (url.pathname === "/api/logs") return json(await listLogs(db, filters(url)))
      const trace = url.pathname.match(/^\/api\/traces\/([a-f\d]{32})$/i)
      if (trace) return json(await getTrace(db, traceId(trace[1])))
      const log = url.pathname.match(/^\/api\/logs\/([a-f\d-]{36}(?::|%3a)\d{1,4})$/i)
      if (log) return json(await getLog(db, decodeURIComponent(log[1])))
      const batch = url.pathname.match(/^\/api\/batches\/([a-f\d-]{36})$/i)
      if (batch) {
        const stored = await getBatch(db, batch[1])
        return new Response(stored.raw, { headers: { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="otlp-${stored.signal}-${stored.id}.json"` } })
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Unknown query" }, 404)
      if (url.pathname === "/viewer") {
        const assetUrl = new URL("/vendor/trace-waterfall-viewer/", url)
        const response = await env.ASSETS.fetch(new Request(assetUrl, request))
        if (!response.ok) return response
        const headers = new Headers(response.headers)
        headers.set("cache-control", "no-store")
        headers.delete("etag")
        return new HTMLRewriter()
          .on("html", { element(element) { element.setAttribute("data-local-observability", "viewer") } })
          .on("head", { element(element) { element.prepend('<base href="/vendor/trace-waterfall-viewer/">', { html: true }); element.append('<link rel="stylesheet" href="/app.css">', { html: true }) } })
          .on('script[type="module"]', { element(element) { element.setAttribute("src", "/viewer-bootstrap.js"); element.setInnerContent("") } })
          .on("#welcome .lede", { element(element) { element.setInnerContent("This view reads retained traces from your local receiver. You can also open a local trace file; file rendering stays in this browser.") } })
          .transform(new Response(response.body, { status: response.status, headers }))
      }
      return env.ASSETS.fetch(request)
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status, cors)
      console.error(JSON.stringify({ event: "local_observability_request_failed", status: 500 }))
      return json({ error: "Local storage or viewer request failed" }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>
