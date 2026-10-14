import type { SpanContext } from "@opentelemetry/api"

type NativeSpan = NonNullable<ReturnType<ExecutionContext["tracing"]["getActiveSpan"]>>
type NativeTrace = Partial<Pick<NativeSpan, "isTraced">> & { spanContext?: () => SpanContext }
type Sampling = "selected" | "not_selected" | "unavailable"
const owned = new Set(["alook_upstream", "alook_server", "alook_sampling"])
const identifier = (value: unknown, size: number) => typeof value === "string" && new RegExp("^[0-9a-f]{" + size + "}$").test(value) && !/^0+$/.test(value)

function metrics(header: string): string[] {
  const result: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let i = 0; i < header.length; i++) {
    const char = header[i]
    if (escaped) { escaped = false; continue }
    if (quoted && char === "\\") { escaped = true; continue }
    if (char === '"') quoted = !quoted
    else if (char === "," && !quoted) { result.push(header.slice(start, i).trim()); start = i + 1 }
  }
  result.push(header.slice(start).trim())
  return result.filter(Boolean)
}

function description(header: string, name: string) {
  if (header.length > 4096) return
  const matches = metrics(header).filter(metric => metric.split(";", 1)[0]?.trim() === name)
  if (matches.length !== 1) return
  return new RegExp("^" + name + ';\\s*desc="([a-z0-9_-]+)"$').exec(matches[0]!)?.[1]
}

export function responseTraceContext(value: string | null | undefined): SpanContext | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value ?? "")
  return match && identifier(match[1], 32) && identifier(match[2], 16)
    ? { traceId: match[1]!, spanId: match[2]!, traceFlags: parseInt(match[3]!, 16) }
    : undefined
}

function nativeContext(span?: NativeTrace) {
  try {
    const value = typeof span?.spanContext === "function" ? span.spanContext() : undefined
    return value && identifier(value.traceId, 32) && identifier(value.spanId, 16)
      && Number.isInteger(value.traceFlags) && value.traceFlags >= 0 && value.traceFlags <= 255
      ? value : undefined
  } catch { return undefined }
}

export function traceResponse(response: Response, request: Request, span?: NativeTrace) {
  if (response.status === 101 || response.status === 0) return response
  const upstream = responseTraceContext(request.headers.get("traceparent"))
  const server = nativeContext(span)
  const sampling: Sampling = typeof span?.isTraced === "boolean" ? span.isTraced ? "selected" : "not_selected" : "unavailable"
  const headers = new Headers(response.headers)
  const existing = metrics(headers.get("server-timing") ?? "").filter(metric => !owned.has(metric.split(";", 1)[0]?.trim() ?? ""))
  if (upstream) existing.push('alook_upstream;desc="' + upstream.traceId + "-" + upstream.spanId + '"')
  existing.push('alook_sampling;desc="' + sampling + '"')
  if (server) {
    const parent = "00-" + server.traceId + "-" + server.spanId + "-" + server.traceFlags.toString(16).padStart(2, "0")
    existing.push('alook_server;desc="' + parent + '"')
    if (!existing.some(metric => metric.split(";", 1)[0]?.trim() === "traceparent")) existing.push('traceparent;desc="' + parent + '"')
  }
  headers.set("server-timing", existing.join(", "))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function readTraceResponse(header: string, client: Pick<SpanContext, "traceId" | "spanId">) {
  const upstream = description(header, "alook_upstream")
  const matched = identifier(client.traceId, 32) && identifier(client.spanId, 16) && upstream === client.traceId + "-" + client.spanId
  const sampling = description(header, "alook_sampling")
  const server = matched ? responseTraceContext(description(header, "alook_server")) : undefined
  return {
    matched,
    server,
    sampling: matched && (sampling === "selected" || sampling === "not_selected") ? sampling : "unavailable" as Sampling,
  }
}
