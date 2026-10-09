import { actionNames, apiRoutes, pageRoutes } from "./coverage"

export const eventNames = [
  "action.start", "action.finish", "navigation.intent", "navigation.commit", "navigation.ready",
  "cache.restore.start", "cache.restore.finish", "query.lifecycle",
  "region.ready_commit", "request.start", "request.headers",
  "request.body_parsed", "request.finish", "data.publish", "data.response_rejected",
  "ws.connect", "ws.ready", "ws.close", "ws.reconnect", "ws.event_applied",
  "main_thread.longtask", "telemetry.coverage", "telemetry.drop", "business.result", "message.milestone",
] as const
export type TelemetryEvent = typeof eventNames[number]
export type Attributes = Record<string, string | number | boolean | undefined>

const names = new Set<string>(actionNames)
const routes = new Set<string>([...pageRoutes, ...apiRoutes, "/external", "/unmapped", "/_next/resource"])
const enumValues: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  environment: ["production", "qa", "development"],
  worker_version_status: ["present", "missing"],
  release_status: ["present", "missing"],
  environment_status: ["present", "missing"],
  trace_context: ["received", "missing"],
  auth_instance: ["created", "reused", "request_local"],
  auth_reuse_reason: ["cold", "version_changed", "configuration_changed", "version_missing", "match"],
  frontend_surface: ["web", "blog", "webview"],
  client_platform: ["browser", "desktop", "mobile"],
  navigation_kind: ["document", "route"],
  phase: ["intent", "headers", "body", "read", "primary", "background", "hydrate", "idb_read", "deserialize", "commit", "frame", "interaction", "optimistic", "ack", "upload", "transport", "auth", "token", "validation"],
  outcome: ["success", "error", "cancelled", "superseded", "timeout", "noop", "observed", "unknown", "empty", "miss", "hit", "expired", "buster", "rejected", "disabled", "unavailable", "partial"],
  source: ["restored_idb", "network", "ws", "local_mutation", "mixed", "unknown"],
  eligibility: ["eligible", "rejected", "unknown", "denied"],
  request_reason: ["foreground", "prefetch", "background", "restore_invalidate", "pagination", "command", "router", "unknown"],
  request_kind: ["api", "rsc", "resource", "document", "external", "unknown"],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  region: ["shell", "rail", "sidebar", "messages", "forum", "thread_opener", "friends", "bots", "machines", "members", "settings", "billing", "file_preview", "inbox", "page"],
  visibility: ["visible", "hidden", "unknown"],
  capability: ["available", "limited", "unavailable"],
  drop_reason: ["early_queue_full", "transport_failure", "withdrawal", "account_switch", "stale_session", "sdk_load", "invalid_config", "unload_unknown"],
  cache_stage: ["idb", "query", "router", "http", "canonical"],
}).map(([key, values]) => [key, new Set(values)]))
const numberFields = new Set(["start_ms", "duration_ms", "count", "row_count", "changed_count", "removed_count", "status", "schema_version", "revision", "attempt", "collection_rate", "drop_count", "transfer_bytes", "encoded_bytes", "decoded_bytes"])
const idFields = new Set(["ws_event_id", "session_id", "page_instance_id", "action_id", "navigation_id", "request_id", "prefetch_action_id", "worker_version", "user_key"])

export function cleanAttributes(input: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    const text = String(value)
    if (enumValues[key]?.has(text)) result[key] = text
    else if (numberFields.has(key) && value !== undefined && text.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e15) result[key] = text
    else if (idFields.has(key) && /^[a-zA-Z0-9_-]{1,80}$/.test(text)) result[key] = text
    else if (key === "release" && /^[0-9a-f]{40}$/.test(text)) result[key] = text
    else if (key === "app_version" && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-[a-zA-Z0-9.-]{1,32})?(?:\+[a-zA-Z0-9.-]{1,32})?$/.test(text)) result[key] = text
    else if (key === "route_template" && routes.has(text)) result[key] = text
    else if (key === "action_name" && names.has(text)) result[key] = text
    else if (key === "cf_ray" && /^[0-9a-f]{16}-[A-Z]{3}$/.test(text)) result[key] = text
    else if ((key === "trace_id" || key === "upstream_trace_id") && /^[0-9a-f]{32}$/.test(text)) result[key] = text
    else if ((key === "span_id" || key === "upstream_span_id") && /^[0-9a-f]{16}$/.test(text)) result[key] = text
    else if (key === "event_type" && /^(community:|connection\.|auth\.)[a-z_.]{1,50}$/.test(text)) result[key] = text
  }
  return result
}
