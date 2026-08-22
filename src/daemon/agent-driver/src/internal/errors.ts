import type { AgentDriverError, JsonObject, JsonValue } from "../contract.js";

const MAX_PUBLIC_ERROR_MESSAGE = 1_000;
const CREDENTIAL_NAME = String.raw`(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:api[_-]?key|access[_-]?key|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|access[_-]?token|auth(?:orization)?|password|passwd|token|voucher)(?:[_-][A-Za-z0-9]{1,32}){0,4}`;
const QUOTED_CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(["'])(${CREDENTIAL_NAME})\1\s*[:=]\s*(["'])[^"'\r\n]*\3`,
  "gi",
);
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])((?:${CREDENTIAL_NAME})\s*[:=]\s*)(?!\[redacted\])[^\s,;}\]]+`,
  "gi",
);

export function scrubDriverErrorMessage(value: unknown, fallback = "Runtime operation failed"): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const scrubbed = text
    .replace(/\b(?:cmk|cmt|crk)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[abprs])-[A-Za-z0-9._\-]+/gi, "[redacted-token]")
    .replace(QUOTED_CREDENTIAL_ASSIGNMENT, '$1$2$1:$3[redacted]$3')
    .replace(CREDENTIAL_ASSIGNMENT, "$1[redacted]")
    .replace(/(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,320}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,63}/g, "[redacted-email]")
    .replace(/([?&])([^=\s]+)=([^&\s]+)/g, "$1$2=[redacted]")
    .replace(/\/(?:Users|home)\/[^\r\n,;]+/g, "[redacted-path]")
    .replace(/[A-Za-z]:\\Users\\[^\r\n,;]+/gi, "[redacted-path]")
    .replace(/\\\\[^\\\s]+\\[^\r\n,;]+/g, "[redacted-path]")
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
