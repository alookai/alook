import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logRequest } from "./request-logger";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function parseLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((c) => JSON.parse(c[0] as string));
}

describe("logRequest", () => {
  it("logs info for 2xx status", () => {
    logRequest("GET", "/api/agents", 200, 15);
    const entries = parseLines(logSpy);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      msg: "http request",
      method: "GET",
      path: "/api/agents",
      status: 200,
    });
  });

  it("logs warn for 4xx status", () => {
    logRequest("POST", "/api/agents", 400, 5);
    const entries = parseLines(logSpy);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "warn",
      status: 400,
    });
  });

  it("logs error for 5xx status", () => {
    logRequest("GET", "/api/agents", 500, 100);
    const entries = parseLines(errorSpy);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "error",
      status: 500,
    });
  });

  it("skips /health endpoint", () => {
    logRequest("GET", "/health", 200, 1);
    logRequest("GET", "/api/health", 200, 1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("includes requestId and userId when provided", () => {
    logRequest("GET", "/api/test", 200, 10, "req-1", "u1");
    const entries = parseLines(logSpy);
    expect(entries[0]).toMatchObject({
      requestId: "req-1",
      userId: "u1",
    });
  });
});
