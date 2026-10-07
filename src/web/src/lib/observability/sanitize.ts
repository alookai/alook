import type { TransportItem, EventEvent, ExceptionEvent, MeasurementEvent, TraceEvent } from "@grafana/faro-web-sdk"
import { actionNames, routeTemplate } from "./coverage"
import { cleanAttributes, eventNames } from "./schema"
import type { FrontendIdentity } from "./runtime"

const actions = new Set<string>(actionNames)
const events = new Set<string>([...eventNames, "session_start", "session_resume", "session_extend", "faro.user.action", "faro.tracing.fetch", "faro.tracing.xml-http-request"])
const errors = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AbortError", "DOMException"])
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const hex = (value: unknown, size: number) => typeof value === "string" && new RegExp("^[0-9a-f]{" + size + "}$").test(value) ? value : undefined
const nano = (value: unknown) => typeof value === "string" && /^\d{1,22}$/.test(value) ? value : undefined

export function sanitizeTrace(input: unknown, sessionId: string, origin: string, identity?: Partial<FrontendIdentity>) {
  const canonical = identity ? { frontend_surface: identity.frontend_surface, client_platform: identity.client_platform, app_version: identity.app_version } : {}
  const context = cleanAttributes(canonical)
  const resources = array(record(input).resourceSpans).flatMap(resource => {
    const scopes = array(record(resource).scopeSpans).flatMap(scope => {
      const spans = array(record(scope).spans).flatMap(raw => {
        const span = record(raw)
        const fields = Object.fromEntries(array(span.attributes).map(rawAttribute => {
          const attribute = record(rawAttribute)
          const value = record(attribute.value)
          return [String(attribute.key), value.stringValue ?? value.intValue ?? value.doubleValue]
        }))
        if (fields["session.id"] !== sessionId) return []
        const url = String(fields["url.full"] ?? fields["http.url"] ?? "")
        const rawMethod = fields["http.request.method"] ?? fields["http.method"]
        const method = typeof rawMethod === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(rawMethod) ? rawMethod : undefined
        const template = cleanAttributes({ route_template: fields.route_template }).route_template ?? routeTemplate(url, origin)
        const attributes = cleanAttributes({ ...fields, ...canonical, route_template: template, session_id: sessionId })
        for (const key of ["http.status_code", "http.response.status_code"]) {
          if (numeric(Number(fields[key])) && Number(fields[key]) <= 599) attributes[key] = String(fields[key])
        }
        if (method !== undefined) attributes["http.request.method"] = method
        attributes["session.id"] = sessionId
        const traceId = hex(span.traceId, 32), spanId = hex(span.spanId, 16)
        const startTimeUnixNano = nano(span.startTimeUnixNano), endTimeUnixNano = nano(span.endTimeUnixNano)
        if (!traceId || !spanId || !startTimeUnixNano || !endTimeUnixNano) return []
        return [{
          traceId, spanId, parentSpanId: hex(span.parentSpanId, 16),
          name: actions.has(String(span.name)) ? String(span.name) : (method ? method + " " : "") + String(template),
          kind: (Number(span.kind) >= 0 && Number(span.kind) <= 5 ? Number(span.kind) : 0) as 0 | 1 | 2 | 3 | 4 | 5,
          startTimeUnixNano,
          endTimeUnixNano,
          attributes: Object.entries(attributes).map(([key,value]) => ({ key, value: { stringValue: value } })),
          status: { code: (Number(record(span.status).code) === 2 ? 2 : 0) as 0 | 2 },
          droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
          events: [], links: [],
        }]
      })
      return spans.length ? [{ scope: { name: "alook.frontend" }, spans }] : []
    })
    const attributes = { "service.name": "alook-web", ...(context.app_version ? { "service.version": context.app_version } : {}), ...context }
    return scopes.length ? [{ resource: { attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })), droppedAttributesCount: 0 }, scopeSpans: scopes }] : []
  })
  return resources.length ? { resourceSpans: resources } : null
}

export function sanitizeItem(item: TransportItem, sessionId: string, origin: string, identity?: Partial<FrontendIdentity>): TransportItem | null {
  if (item.meta.session?.id !== sessionId) return null
  const sdk = item.meta.sdk
  if (sdk?.name !== "faro-web" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(sdk.version ?? "")) return null
  const canonical = identity ? { frontend_surface: identity.frontend_surface, client_platform: identity.client_platform, app_version: identity.app_version } : {}
  const context = cleanAttributes(canonical)
  const version = cleanAttributes({ app_version: identity ? identity.app_version : item.meta.app?.version }).app_version
  const meta = {
    sdk: { name: sdk.name, version: sdk.version },
    app: { name: "alook-web", version, ...cleanAttributes({ release: item.meta.app?.release, environment: item.meta.app?.environment }) },
    session: { id: sessionId, attributes: { isSampled: "true", ...context } },
    page: { id: item.meta.page?.id, url: origin + routeTemplate(item.meta.page?.url ?? "/", origin) },
    ...(item.meta.user?.id && /^[a-zA-Z0-9_-]{8,64}$/.test(item.meta.user.id) ? { user: { id: item.meta.user.id } } : {}),
  }
  if (item.type === "log") return null
  if (item.type === "event") {
    const payload = item.payload as EventEvent
    if (!events.has(payload.name)) return null
    if (payload.name.startsWith("faro.tracing.") && payload.attributes?.["session.id"] !== sessionId) return null
    if (payload.attributes?.session_id && payload.attributes.session_id !== sessionId) return null
    const attrs = cleanAttributes({ ...payload.attributes, ...canonical })
    if (payload.name.startsWith("faro.tracing.")) {
      const fields = payload.attributes ?? {}
      const url = String(fields["url.full"] ?? fields["http.url"] ?? "")
      let kind = "unknown"
      try { const parsed = new URL(url, origin); kind = parsed.origin !== origin ? "external" : parsed.searchParams.has("_rsc") ? "rsc" : parsed.pathname.startsWith("/api/") ? "api" : "resource" } catch {}
      Object.assign(attrs, cleanAttributes({ route_template: routeTemplate(url, origin), request_kind: kind, duration_ms: Number(fields.duration_ns) / 1e6, method: fields["http.request.method"] ?? fields["http.method"], status: fields["http.response.status_code"] ?? fields["http.status_code"], session_id: sessionId }))
    }
    if (payload.name === "faro.user.action") {
      const name = payload.attributes?.["userActionName"]
      if (!name || !actions.has(name)) return null
      attrs.userActionName = name
      for (const field of ["userActionDuration", "userActionStartTime", "userActionEndTime"]) {
        const value = Number(payload.attributes?.[field])
        if (numeric(value)) attrs[field] = String(value)
      }
    }
    return { ...item, meta, payload: { name: payload.name, timestamp: payload.timestamp, domain: "alook.frontend", attributes: { ...attrs, ...context }, ...(payload.trace && hex(payload.trace.trace_id, 32) && hex(payload.trace.span_id, 16) ? { trace: payload.trace } : {}) } }
  }
  if (item.type === "exception") {
    const payload = item.payload as ExceptionEvent
    return { ...item, meta, payload: { timestamp: payload.timestamp, type: errors.has(payload.type) ? payload.type : "Error", value: "[redacted]", stacktrace: { frames: (payload.stacktrace?.frames ?? []).slice(0,20).flatMap(frame => {
      try {
        const url = new URL(frame.filename, origin)
        if (url.origin !== origin || !/^\/(?:blog-static\/)?_next\/static\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) return []
        return [{ filename: origin + url.pathname, function: "[redacted]", ...(numeric(frame.lineno) ? { lineno: frame.lineno } : {}), ...(numeric(frame.colno) ? { colno: frame.colno } : {}) }]
      } catch { return [] }
    }) } } }
  }
  if (item.type === "measurement") {
    const payload = item.payload as MeasurementEvent
    if (payload.type !== "web-vitals") return null
    const values = Object.fromEntries(Object.entries(payload.values).filter(([key,value]) => /^(LCP|CLS|INP|FCP|TTFB|FID|lcp|cls|inp|fcp|ttfb|fid)$/.test(key) && numeric(value)))
    return Object.keys(values).length ? { ...item, meta, payload: { type: payload.type, timestamp: payload.timestamp, values } } : null
  }
  if (item.type === "trace") {
    const payload = sanitizeTrace(item.payload, sessionId, origin, identity)
    return payload ? { ...item, meta, payload: payload as TraceEvent } : null
  }
  return null
}
