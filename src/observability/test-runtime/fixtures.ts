export const TRACE = "a".repeat(32)
export const OTHER_TRACE = "b".repeat(32)
export const ROOT = "1".repeat(16)
export const CHILD = "2".repeat(16)
export const attr = (key: string, value: string) => ({ key, value: { stringValue: value } })
export function span(overrides = {}) {
  return {
    traceId: TRACE, spanId: ROOT, name: "document", startTimeUnixNano: "1780000000000000001", endTimeUnixNano: "1780000008625000001",
    attributes: [attr("observation_kind", "document"), attr("page_instance_id", "page-1"), attr("session_id", "session-1")],
    events: [{ name: "native-event", timeUnixNano: "1780000000000000003" }], links: [{ traceId: OTHER_TRACE, spanId: CHILD }],
    extraOriginalField: { preserved: true }, ...overrides,
  }
}
export function traceDocument(records = [span()]) {
  return {
    resourceSpans: [{ resource: { attributes: [attr("service.name", "alook-web")], originalResource: true }, schemaUrl: "resource-schema", scopeSpans: [{ scope: { name: "native", version: "1" }, schemaUrl: "scope-schema", spans: records }] }],
  }
}
export function logDocument(overrides = {}) {
  return { resourceLogs: [{ resource: { attributes: [attr("service.name", "alook-web")] }, scopeLogs: [{ scope: { name: "@grafana/faro-web-sdk", version: "2.12.1" }, logRecords: [{
    timeUnixNano: 1780000000000000000, body: { stringValue: "navigation.ready" }, attributes: [
      attr("event.name", "navigation.ready"),
      { key: "event.attributes", value: { kvlistValue: { values: [attr("trace_id", TRACE), attr("page_instance_id", "page-1"), attr("session_id", "session-1")] } } },
    ], ...overrides,
  }] }] }] }
}
