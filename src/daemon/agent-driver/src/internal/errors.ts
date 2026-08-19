import type { AgentDriverError } from "../contract.js";

const MAX_PUBLIC_ERROR_MESSAGE = 1_000;

export function scrubDriverErrorMessage(value: unknown, fallback = "Runtime operation failed"): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const scrubbed = text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[abprs])-[A-Za-z0-9._\-]+/gi, "[redacted-token]")
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/([?&])([^=\s]+)=([^&\s]+)/g, "$1$2=[redacted]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/:]+[\\/]){1,}[^\s:]*/g, "[redacted-path]")
    .trim();
  return (scrubbed || fallback).slice(0, MAX_PUBLIC_ERROR_MESSAGE);
}

export function scrubDriverError(error: AgentDriverError): AgentDriverError {
  return { ...error, message: scrubDriverErrorMessage(error.message) };
}

export function stableErrorCode(value: unknown, fallback: string): string {
  const code = String(value ?? "");
  return /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : fallback;
}
