import { NextResponse } from "next/server";

export function writeJSON(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function writeError(message: string, status: number, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

/** Format a Date or ISO string as RFC 3339 without sub-second precision (matching Go output). */
export function formatTimestamp(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Returns [data, null] on success or [null, 400 response] on failure.
 */
export async function parseBody<T>(
  req: Request,
  schema: { parse(data: unknown): T },
): Promise<[T, null] | [null, NextResponse]> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return [null, writeError("invalid request body", 400)];
  }
  try {
    const data = schema.parse(raw);
    return [data, null];
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    const issues: { path: (string | number)[]; message: string }[] =
      (e.issues ?? e.errors ?? []) as { path: (string | number)[]; message: string }[];
    const fields = issues.map(
      (e) => `${e.path.join(".")}: ${e.message}`,
    );
    return [
      null,
      NextResponse.json(
        { error: "validation error", details: fields },
        { status: 400 },
      ),
    ];
  }
}

/** Same as formatTimestamp but returns null instead of empty string. */
export function formatTimestampNullable(date: Date | string | null): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
