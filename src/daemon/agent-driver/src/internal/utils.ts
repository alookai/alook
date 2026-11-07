
import { randomUUID } from "crypto";

export function jsonRpcRequest(method: string, params: unknown, id?: string | number): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? randomUUID(), method, params });
}

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
