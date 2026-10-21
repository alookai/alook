import { InputError, LIMITS } from "./limits"

export type ObjectValue = Record<string, unknown>
export type Pointer = { resourceIndex: number; scopeIndex: number; recordIndex: number }
type References = { pageInstanceId: string; sessionId: string }
type SpanIndex = Pointer & References & {
  traceId: string; spanId: string; parentSpanId: string; name: string; service: string
  startNano: string; endNano: string
}
type LogIndex = Pointer & References & {
  traceId: string; customTraceId: string; timeNano: string; eventName: string; summary: string
}
export type ParsedBatch = { signal: "traces" | "logs"; document: ObjectValue; spans: SpanIndex[]; logs: LogIndex[]; records: number }

export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Expected a JSON object")
  return value as ObjectValue
}

function array(value: unknown) {
  if (!Array.isArray(value)) throw new InputError("Expected an OTLP array")
  return value as unknown[]
}

export function traceId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f\d]{32}$/i.test(value) || /^0+$/.test(value)) throw new InputError("Invalid trace ID")
  return value.toLowerCase()
}

function spanId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f\d]{16}$/i.test(value) || /^0+$/.test(value)) throw new InputError("Invalid span ID")
  return value.toLowerCase()
}

export function nanoKey(value: unknown) {
  let text: string
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) text = BigInt(value).toString()
  else if (typeof value === "string" && /^\d{1,20}$/.test(value)) text = value
  else throw new InputError("Invalid nanosecond timestamp")
  if (BigInt(text) > 18446744073709551615n) throw new InputError("Nanosecond timestamp exceeds uint64")
  return BigInt(text).toString().padStart(20, "0")
}

function label(value: unknown, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : ""
}

function attributes(value: unknown): ObjectValue {
  const result: ObjectValue = {}
  if (!Array.isArray(value)) return result
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const item = entry as ObjectValue
    if (typeof item.key !== "string" || !item.value || typeof item.value !== "object") continue
    result[item.key] = anyValue(item.value as ObjectValue)
  }
  return result
}

function anyValue(value: ObjectValue): unknown {
  if (value.kvlistValue && typeof value.kvlistValue === "object") return attributes((value.kvlistValue as ObjectValue).values)
  if (value.arrayValue && typeof value.arrayValue === "object") {
    const values = (value.arrayValue as ObjectValue).values
    return Array.isArray(values) ? values.map(v => v && typeof v === "object" ? anyValue(v as ObjectValue) : null) : []
  }
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? null
}

function references(values: ObjectValue): References {
  const page = values["page.attributes"]
  const session = values["session.attributes"]
  return {
    pageInstanceId: label(values.page_instance_id ?? (page && typeof page === "object" ? (page as ObjectValue).page_instance_id : undefined), 128),
    sessionId: label(values.session_id ?? (session && typeof session === "object" ? (session as ObjectValue).session_id : values["session.id"]), 128),
  }
}

function optionalTrace(value: unknown) {
  if (value === undefined || value === "" || value === null || (typeof value === "string" && /^0+$/.test(value))) return ""
  return traceId(value)
}

function customTrace(value: unknown) {
  return typeof value === "string" && /^[a-f\d]{32}$/i.test(value) && !/^0+$/.test(value) ? value.toLowerCase() : ""
}

export function parseBatch(raw: string, signal: "traces" | "logs"): ParsedBatch {
  let document: ObjectValue
  try { document = object(JSON.parse(raw)) } catch { throw new InputError("Invalid OTLP JSON object") }
  const spans = new Map<string, SpanIndex>()
  const logs: LogIndex[] = []
  const resources = array(document[signal === "traces" ? "resourceSpans" : "resourceLogs"])
  let records = 0
  resources.forEach((resourceValue, resourceIndex) => {
    const resource = object(resourceValue)
    const resourceAttrs = attributes(resource.resource && object(resource.resource).attributes)
    const scopes = array(resource[signal === "traces" ? "scopeSpans" : "scopeLogs"])
    scopes.forEach((scopeValue, scopeIndex) => {
      const scope = object(scopeValue)
      const entries = array(scope[signal === "traces" ? "spans" : "logRecords"])
      entries.forEach((entryValue, recordIndex) => {
        if (++records > LIMITS.recordsPerRequest) throw new InputError("Too many OTLP records", 413)
        const entry = object(entryValue)
        const attrs = { ...resourceAttrs, ...attributes(entry.attributes) }
        const pointer = { resourceIndex, scopeIndex, recordIndex }
        if (signal === "traces") {
          const startNano = nanoKey(entry.startTimeUnixNano)
          const endNano = nanoKey(entry.endTimeUnixNano)
          if (endNano < startNano) throw new InputError("Span ends before it starts")
          const row: SpanIndex = {
            ...pointer, ...references(attrs), traceId: traceId(entry.traceId), spanId: spanId(entry.spanId),
            parentSpanId: entry.parentSpanId && !/^0+$/.test(String(entry.parentSpanId)) ? spanId(entry.parentSpanId) : "",
            name: label(entry.name), service: label(resourceAttrs["service.name"], 96), startNano, endNano,
          }
          spans.set(row.traceId + row.spanId, row)
        } else {
          const eventAttributes = attrs["event.attributes"]
          const custom = eventAttributes && typeof eventAttributes === "object" && !Array.isArray(eventAttributes) ? eventAttributes as ObjectValue : {}
          const fields = { ...attrs, ...custom }
          const bodyText = typeof entry.body === "object" && entry.body ? anyValue(entry.body as ObjectValue) : entry.body
          logs.push({
            ...pointer, ...references(fields), traceId: optionalTrace(entry.traceId),
            customTraceId: customTrace(custom.trace_id),
            timeNano: nanoKey(entry.timeUnixNano ?? entry.observedTimeUnixNano ?? 0),
            eventName: label(fields["event.name"] ?? fields["measurement.name"]),
            summary: label(typeof bodyText === "string" ? bodyText : JSON.stringify(bodyText ?? null), 512),
          })
        }
      })
    })
  })
  const result = { signal, document, spans: [...spans.values()], logs, records }
  if (new TextEncoder().encode(JSON.stringify({ spans: result.spans, logs })).byteLength > LIMITS.indexBytes) throw new InputError("OTLP index exceeds local capacity", 413)
  return result
}

export function recordAt(document: ObjectValue, signal: "traces" | "logs", pointer: Pointer) {
  const resource = object(array(document[signal === "traces" ? "resourceSpans" : "resourceLogs"])[pointer.resourceIndex])
  const scope = object(array(resource[signal === "traces" ? "scopeSpans" : "scopeLogs"])[pointer.scopeIndex])
  const record = object(array(scope[signal === "traces" ? "spans" : "logRecords"])[pointer.recordIndex])
  return { resource, scope, record }
}
