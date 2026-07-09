import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => {
  return {
    NextResponse: {
      json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
        return { body: data, status: init?.status ?? 200, headers: init?.headers };
      },
    },
  };
});

import {
  writeJSON,
  writeError,
  parseBody,
  formatTimestamp,
  formatTimestampNullable,
} from "./helpers";
describe("formatTimestamp", () => {
  it("strips milliseconds from ISO string", () => {
    const d = new Date("2024-01-15T10:30:00.000Z");
    expect(formatTimestamp(d)).toBe("2024-01-15T10:30:00Z");
  });

  it("returns empty string for null", () => {
    expect(formatTimestamp(null)).toBe("");
  });

  it("handles non-zero milliseconds", () => {
    const d = new Date("2024-01-15T10:30:45.123Z");
    expect(formatTimestamp(d)).toBe("2024-01-15T10:30:45Z");
  });
});

describe("formatTimestampNullable", () => {
  it("returns null for null input", () => {
    expect(formatTimestampNullable(null)).toBeNull();
  });

  it("strips milliseconds for non-null dates", () => {
    const d = new Date("2024-01-15T10:30:00.000Z");
    expect(formatTimestampNullable(d)).toBe("2024-01-15T10:30:00Z");
  });
});

describe("writeJSON", () => {
  it("returns response with default status 200", () => {
    const res = writeJSON({ ok: true }) as any;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns response with custom status", () => {
    const res = writeJSON({ items: [] }, 201) as any;
    expect(res.status).toBe(201);
  });
});

describe("writeError", () => {
  it("returns { error: message } with correct status", () => {
    const res = writeError("Not found", 404) as any;
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 500 for server errors", () => {
    const res = writeError("Internal", 500) as any;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal" });
  });

  it("omits headers when not provided (no regression for existing 2-arg call sites)", () => {
    const res = writeError("Not found", 404) as any;
    expect(res.headers).toBeUndefined();
  });

  it("sets the provided headers when a third argument is passed", () => {
    const res = writeError("rate limited", 429, { "Retry-After": "7" }) as any;
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "rate limited" });
    expect(res.headers).toEqual({ "Retry-After": "7" });
  });
});

// ---------------------------------------------------------------------------
// parseBody
// ---------------------------------------------------------------------------

const TestSchema = {
  parse(data: unknown) {
    const obj = data as Record<string, unknown>;
    if (typeof obj?.name !== "string") {
      throw { issues: [{ path: ["name"], message: "Expected string" }] };
    }
    if (typeof obj?.age !== "number") {
      throw { issues: [{ path: ["age"], message: "Expected number" }] };
    }
    return obj as { name: string; age: number };
  },
};

function fakeRequest(body: unknown, valid = true): Request {
  return {
    json: valid
      ? () => Promise.resolve(body)
      : () => Promise.reject(new Error("bad json")),
  } as unknown as Request;
}

describe("parseBody", () => {
  it("returns [data, null] for valid body", async () => {
    const [data, err] = await parseBody(
      fakeRequest({ name: "Alice", age: 30 }),
      TestSchema,
    );
    expect(err).toBeNull();
    expect(data).toEqual({ name: "Alice", age: 30 });
  });

  it("returns [null, 400 response] for invalid body with field-level errors", async () => {
    const [data, err] = await parseBody(
      fakeRequest({ name: 123 }),
      TestSchema,
    );
    expect(data).toBeNull();
    expect((err as any).status).toBe(400);
    expect((err as any).body.error).toBe("validation error");
    expect((err as any).body.details.length).toBeGreaterThan(0);
  });

  it("returns [null, 400 response] for malformed JSON", async () => {
    const [data, err] = await parseBody(
      fakeRequest(null, false),
      TestSchema,
    );
    expect(data).toBeNull();
    expect((err as any).status).toBe(400);
    expect((err as any).body.error).toBe("invalid request body");
  });
});
