/**
 * Small helpers shared across driver files. Each kills a duplication pattern
 * that had multiple drivers copy-pasting the same 3-4 lines.
 */
import type { ChildProcess } from "child_process";
import { randomUUID } from "crypto";

/**
 * Write `payload` (already includes any trailing newline) to a child's stdin
 * on the next microtask, then close stdin. Used by drivers whose runtime is
 * one-shot: they spawn, deliver the prompt, and the runtime exits when
 * stdin closes.
 *
 * `queueMicrotask` mirrors codex's original pattern — it lets the caller
 * finish attaching stdout/stderr listeners before the write is scheduled, so
 * the child can never emit its first line into a listener-less pipe.
 */
export function writeToStdinAndDetach(proc: ChildProcess, payload: string): void {
  queueMicrotask(() => {
    proc.stdin?.write(payload);
    proc.stdin?.end();
  });
}

/**
 * Build a JSON-RPC 2.0 request string (no trailing newline — the caller
 * appends one when writing to stdin). Both Codex and Kimi speak JSON-RPC over
 * stdio and every request they send follows this exact shape; centralize the
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
