/**
 * Small helpers shared across driver files. Each kills a duplication pattern
 * that had multiple drivers copy-pasting the same 3-4 lines.
 */
import { randomUUID } from "crypto";

/**
 * Build a JSON-RPC 2.0 request string (no trailing newline — the caller
 * appends one when writing to stdin). Codex uses this envelope for every
 * request it sends; centralize the
 * envelope so `id` defaulting and `jsonrpc` version live in one place.
 */
export function jsonRpcRequest(method: string, params: unknown, id?: string | number): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? randomUUID(), method, params });
}

/**
 * Parse a single NDJSON line. Every event normalizer that reads a JSON stream
 * needs the same `try/catch → null on parse error` idiom; use this instead of
 * scattering `let msg: any` + try/catch through 8 files.
 */
export function tryParseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function tryParseJsonRecord(line: string): Record<string, unknown> | null {
  return asRecord(tryParseJsonLine(line));
}
