/**
 * Runtime error diagnostics — classify a runtime failure into a stable class
 * and reason, decide whether it needs user action (re-auth), and build a
 * scrubbed telemetry envelope.
 *
 * Classification priority:
 *   1. An explicit `XxxError` / `XxxException` token in the message.
 *   2. HTTP status code (429/401/403/404/5xx/other 4xx).
 *   3. Text-pattern regexes (rate limit, timeout, connection, …).
 *   4. Fallback: `RuntimeError`.
 */
import { createHash } from "crypto";

export type RuntimeErrorClass =
  | "RateLimitError"
  | "AuthError"
  | "NotFoundError"
  | "ModelConfigError"
  | "TimeoutError"
  | "ProviderConnectionError"
  | "ProviderStreamError"
  | "ProviderServerError"
  | "ProviderApiError"
  | "RuntimeError"
  | string;

const REASON_BY_CLASS: Record<string, string> = {
  RateLimitError: "rate_limited",
  AuthError: "auth_failed",
  NotFoundError: "not_found",
  ModelConfigError: "model_config_error",
  TimeoutError: "provider_timeout",
  ProviderConnectionError: "provider_connection_error",
  ProviderStreamError: "provider_stream_error",
  ProviderServerError: "provider_server_error",
  ProviderApiError: "provider_api_error",
  RuntimeError: "unclassified_runtime_error",
};

/** Auth-failure phrasings that mean the human must re-authenticate. */
export const RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS: RegExp[] = [
  /access token could not be refreshed/i,
  /\btoken_(?:revoked|invalidated)\b/i,
  /refresh token was already used/i,
  /access token.*invalidated/i,
  /authentication token has been invalidated/i,
  /logged out or signed in to another account/i,
  /not logged in/i,
  /not signed in/i,
  /login required/i,
  /log in first/i,
  /please log in/i,
  /authentication failed/i,
  /auth(?:entication)? failed/i,
  /authentication timed out/i,
  /missing (?:api )?token/i,
  /no (?:api )?token/i,
  /missing credentials/i,
  /credentials? not found/i,
  /invalid api key/i,
  /api key (?:is )?not set/i,
];

export function isRuntimeAuthActionRequiredText(message: string): boolean {
  return RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS.some((re) => re.test(message));
}

export function extractHttpStatus(message: string): number | null {
  const labeled = /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message);
  if (labeled) return Number(labeled[1]);
  const semantic = /\b([45]\d{2})\s+(?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(
    message,
  );
  return semantic ? Number(semantic[1]) : null;
}

export function classifyRuntimeError(message: string, httpStatus: number | null): RuntimeErrorClass {
  const explicit = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(message);
  if (explicit) return explicit[1];

  if (httpStatus !== null) {
    if (httpStatus === 429) return "RateLimitError";
    if (httpStatus === 401 || httpStatus === 403) return "AuthError";
    if (httpStatus === 404) return "NotFoundError";
    if (httpStatus >= 500) return "ProviderServerError";
    return "ProviderApiError";
  }

  if (/\brate.?limit|too many requests\b/i.test(message)) return "RateLimitError";
  if (isRuntimeAuthActionRequiredText(message)) return "AuthError";
  if (/\bnot found\b/i.test(message)) return "NotFoundError";
  if (/\bmodel\b.*\bnot supported|unsupported.*model|model.*not available\b/i.test(message))
    return "ModelConfigError";
  if (/\b(?:ETIMEDOUT|timeout|timed out)\b/i.test(message)) return "TimeoutError";
  if (/ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\bUnable to connect to API\b/i.test(message))
    return "ProviderConnectionError";
  if (/stream closed before response\.completed|error decoding response body/i.test(message))
    return "ProviderStreamError";
  return "RuntimeError";
}

export function runtimeErrorReason(runtimeErrorClass: RuntimeErrorClass): string {
  return REASON_BY_CLASS[runtimeErrorClass] ?? "unclassified_runtime_error";
}

export function classifyRuntimeErrorAction(
  message: string,
  runtimeErrorClass: RuntimeErrorClass,
): "user_reauth" | "none" {
  if (runtimeErrorClass === "AuthError" && isRuntimeAuthActionRequiredText(message)) return "user_reauth";
  return "none";
}

/** Redact tokens, keys, emails, URL creds and filesystem paths for telemetry. */
export function scrubRuntimeErrorDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[abprs])-[A-Za-z0-9._\-]+/g, "[redacted-token]")
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(\?|&)([^=\s]+)=([^&\s]+)/g, "$1$2=[redacted]")
    .replace(/(\/[^\s]*){2,}/g, "[redacted-path]");
}

function messageLengthBucket(len: number): string {
  if (len === 0) return "0";
  if (len < 1000) return "<1k";
  if (len < 4000) return "1k-4k";
  if (len < 16000) return "4k-16k";
  return "16k+";
}

export interface RuntimeErrorDiagnosticEnvelope {
  spanAttrs: Record<string, unknown>;
  eventAttrs: Record<string, unknown>;
}

export function buildRuntimeErrorDiagnosticEnvelope(message: string): RuntimeErrorDiagnosticEnvelope {
  const httpStatus = extractHttpStatus(message);
  const runtimeErrorClass = classifyRuntimeError(message, httpStatus);
  const runtimeErrorAction = classifyRuntimeErrorAction(message, runtimeErrorClass);
  const scrubbed = scrubRuntimeErrorDiagnosticText(message);
  const fingerprint = createHash("sha256").update(scrubbed).digest("hex").slice(0, 16);

  const spanAttrs: Record<string, unknown> = {
    turn_outcome: "failed",
    turn_subtype: "runtime_error",
    turn_reason: runtimeErrorReason(runtimeErrorClass),
    runtime_error_class: runtimeErrorClass,
    runtime_error_action: runtimeErrorAction,
    runtime_error_action_required: runtimeErrorAction !== "none",
    runtime_error_fingerprint: fingerprint,
    runtime_error_message_present: message.length > 0,
    runtime_error_message_length_bucket: messageLengthBucket(message.length),
    runtime_error_message_truncated: scrubbed.length > 4000,
  };
  if (httpStatus !== null) spanAttrs.runtime_error_http_status = httpStatus;

  return {
    spanAttrs,
    eventAttrs: { ...spanAttrs, runtime_error_message_excerpt: scrubbed.slice(0, 4000) },
  };
}
