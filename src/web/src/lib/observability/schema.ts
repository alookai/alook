import { actionNames, apiRoutes, pageRoutes } from "./coverage"

export const eventNames = [
  "action.start", "action.finish", "navigation.intent", "navigation.commit", "navigation.ready",
  "cache.restore.start", "cache.restore.finish", "region.read",
  "region.ready_commit", "region.frame_estimate", "request.start", "request.headers",
  "request.body_parsed", "request.finish", "data.publish", "data.response_rejected",
  "ws.connect", "ws.ready", "ws.close", "ws.reconnect", "ws.event_applied",
  "resource.finish", "main_thread.longtask", "telemetry.coverage", "telemetry.drop", "business.result", "message.milestone",
  "image.lifecycle", "request.abort", "request.boundary", "query.boundary", "image.operation",
] as const
export type TelemetryEvent = typeof eventNames[number]
export type Attributes = Record<string, string | number | boolean | undefined>
export type Source = "restored_idb" | "network" | "ws" | "local_mutation" | "mixed" | "unknown"

const names = new Set<string>(actionNames)
const routes = new Set<string>([...pageRoutes, ...apiRoutes, "/external", "/unmapped", "/_next/resource"])
const enumValues: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  environment: ["production", "qa"],
  frontend_surface: ["web", "blog", "webview"],
  navigation_kind: ["document", "route"],
  phase: ["intent", "headers", "body", "read", "primary", "background", "hydrate", "idb_read", "deserialize", "commit", "frame", "interaction", "optimistic", "ack", "upload", "transport", "auth", "token", "validation"],
  outcome: ["success", "error", "cancelled", "superseded", "timeout", "noop", "observed", "unknown", "empty", "miss", "hit", "expired", "buster", "rejected", "disabled", "unavailable", "partial"],
  source: ["restored_idb", "network", "ws", "local_mutation", "mixed", "unknown"],
  freshness: ["restored", "validated", "changed", "unknown"],
  eligibility: ["eligible", "rejected", "unknown", "denied"],
  request_reason: ["foreground", "background", "restore_invalidate", "pagination", "command", "router", "unknown"],
  request_kind: ["api", "rsc", "resource", "document", "external", "unknown"],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  region: ["shell", "rail", "sidebar", "messages", "forum", "thread_opener", "friends", "bots", "machines", "members", "settings", "billing", "file_preview", "inbox", "page"],
  visibility: ["visible", "hidden", "unknown"],
  capability: ["available", "limited", "unavailable"],
  drop_reason: ["early_queue_full", "image_rate_limit", "transport_failure", "withdrawal", "account_switch", "stale_session", "sdk_load", "invalid_config", "unload_unknown"],
  delivery_failure_reason: ["queue_full", "retries_exhausted", "rate_limit", "http_error", "network", "timeout", "abort", "unknown"],
  cache_stage: ["idb", "query", "router", "http", "canonical"],
  image_slot: ["identity", "content", "markdown", "lightbox_original", "lightbox_thumbnail", "thumbnail_prepare", "crop", "share", "dom"],
  image_phase: ["attach", "detach", "snapshot", "source_change", "presentation_change", "effect_setup", "effect_cleanup", "eligible", "timer_start", "timer_clear", "timeout", "load", "error", "decode_start", "decode_ready", "decode_error", "decode_unavailable", "pixels_ready", "state", "ignored", "retry", "abort", "encode_start", "encode_ready", "encode_error", "stage_start", "stage_ready", "stage_error"],
  image_state: ["pending", "ready", "error"], previous_state: ["pending", "ready", "error"],
  image_parent: ["button", "other", "none"], loading: ["lazy", "eager"],
  connected: ["true", "false"], complete: ["true", "false"], current_node: ["true", "false"], eligible: ["true", "false"],
  decode_supported: ["true", "false"], decode_called: ["true", "false"], image_element: ["img", "svg_image"],
  image_failure: ["decode_rejected", "no_pixels", "load_error", "abort"],
  ignored_reason: ["inactive", "generation", "attempt", "node", "terminal"],
  delivery_type: ["cache", "prefetch", "unknown"],
  abort_cause: ["unknown", "deadline", "parent_signal", "view_cleanup", "view_retire", "account_retire", "read_superseded", "query_signal", "share_cleanup"],
  abort_phase: ["timer_start", "abort"],
  query_boundary: ["observerAdded", "observerRemoved", "removed", "signal_abort", "account_cancel"],
  image_operation: ["click", "pointerover", "focusin", "keydown", "scroll", "resize", "online"],
  share_stage: ["source", "assets", "fonts", "freeze", "rasterize"],
  operation_key: ["shift_f10", "context_menu", "other"],
  runtime_platform: ["browser", "desktop", "mobile"], native_build_binding: ["unavailable"],
}).map(([key, values]) => [key, new Set(values)]))
const numberFields = new Set(["start_ms", "duration_ms", "ws_duration_ms", "count", "row_count", "changed_count", "removed_count", "status", "schema_version", "revision", "attempt", "collection_rate", "drop_count", "delivery_failure_count", "transfer_bytes", "encoded_bytes", "decoded_bytes", "image_generation", "telemetry_generation", "natural_width", "natural_height", "timeout_ms", "time_origin_ms", "fetch_start_ms", "request_start_ms", "response_start_ms", "response_end_ms", "observer_count", "operation_sequence", "correlation_evictions", "correlation_size"])
const idFields = new Set(["ws_event_id", "session_id", "page_instance_id", "action_id", "navigation_id", "request_id", "resource_id", "data_version", "user_key", "image_instance_id", "image_node_id", "image_parent_id", "mutation_parent_id", "image_source_id", "declared_source_id", "query_id", "abort_owner_id", "operation_target_id"])

export function cleanAttributes(input: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    const text = String(value)
    if (enumValues[key]?.has(text)) result[key] = text
    else if (numberFields.has(key) && value !== undefined && text.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e15) result[key] = text
    else if (idFields.has(key) && /^[a-zA-Z0-9_-]{1,80}$/.test(text)) result[key] = text
    else if (key === "release" && /^[0-9a-f]{40}$/.test(text)) result[key] = text
    else if (key === "route_template" && routes.has(text)) result[key] = text
    else if (key === "action_name" && names.has(text)) result[key] = text
    else if (key === "cf_ray" && /^[0-9a-f]{16}-[A-Z]{3}$/.test(text)) result[key] = text
    else if (key === "trace_id" && /^[0-9a-f]{32}$/.test(text)) result[key] = text
    else if (key === "span_id" && /^[0-9a-f]{16}$/.test(text)) result[key] = text
    else if (key === "event_type" && /^(community:|connection\.|auth\.)[a-z_.]{1,50}$/.test(text)) result[key] = text
  }
  return result
}
