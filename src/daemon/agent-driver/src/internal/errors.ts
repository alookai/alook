import type { AgentDriverError, JsonObject, JsonValue } from "../contract.js";

const MAX_PUBLIC_ERROR_MESSAGE = 1_000;

export function scrubDriverErrorMessage(value: unknown, fallback = "Runtime operation failed"): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const scrubbed = text
    .replace(/(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[abprs])-[A-Za-z0-9._\-]+/gi, "[redacted-token]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)["']?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi, "$1$2[redacted]$2")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\b\s*[:=]\s*)[^\s,;}\]]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/([?&])([^=\s]+)=([^&\s]+)/g, "$1$2=[redacted]")
    .replace(/\/(?:Users|home)\/[^\r\n,;]+/g, "[redacted-path]")
    .replace(/[A-Za-z]:\\Users\\[^\r\n,;]+/gi, "[redacted-path]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/:]+[\\/]){1,}[^\s:]*/g, "[redacted-path]")
    .trim();
  return (scrubbed || fallback).slice(0, MAX_PUBLIC_ERROR_MESSAGE);
}

export function scrubDriverError(error: AgentDriverError): AgentDriverError {
  return {
    ...error,
    code: stableErrorCode(error.code, "runtime_error"),
    message: scrubDriverErrorMessage(error.message),
    ...(error.details ? { details: scrubDetails(error.details) } : {}),
  };
}

function scrubDetails(details: JsonObject): JsonObject {
  const scrubValue = (value: JsonValue, key?: string): JsonValue => {
    if (key && /api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token/i.test(key)) {
      return "[redacted]";
    }
    if (typeof value === "string") return scrubDriverErrorMessage(value, "[redacted]");
    if (Array.isArray(value)) return value.map((item) => scrubValue(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        scrubValue(child as JsonValue, childKey),
      ]));
    }
    return value;
  };
  return scrubValue(details) as JsonObject;
}

export function stableErrorCode(value: unknown, fallback: string): string {
  const code = String(value ?? "");
  return /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : fallback;
}
