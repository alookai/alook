import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@alook/shared";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function parseLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(spy.mock.calls[0][0] as string);
}

describe("Logger", () => {
  it("outputs valid JSON with level, msg, ts fields", () => {
    const logger = new Logger({ service: "web" });
    logger.info("hello");

    const entry = parseLine(logSpy);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes extra context fields in output", () => {
    const logger = new Logger({ service: "web" });
    logger.info("task done", { taskId: "t1", duration: 42 });

    const entry = parseLine(logSpy);
    expect(entry.taskId).toBe("t1");
    expect(entry.duration).toBe(42);
  });

  it("filters messages below configured level", () => {
    const logger = new Logger({ service: "web", level: "warn" });
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("visible");
    logger.error("visible");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("writes error to console.error, others to console.log", () => {
    const logger = new Logger({ service: "web", level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");

    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();

    logger.error("e");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("extracts error message from Error objects", () => {
    const logger = new Logger({ service: "web", level: "error" });
    logger.error("failed", { err: new Error("bad input") });

    const entry = parseLine(errorSpy);
    const serialized = entry.err as { message: string };
    expect(serialized.message).toBe("bad input");
  });

  it("pretty mode outputs human-readable line with datetime", () => {
    const logger = new Logger({ service: "web", pretty: true });
    logger.info("hello");

    const line = logSpy.mock.calls[0][0] as string;
    expect(line.startsWith("{")).toBe(false);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(line).toContain("INFO");
    expect(line).toContain("[web]");
    expect(line).toContain("hello");
  });

  it("pretty mode includes context fields as key=value pairs", () => {
    const logger = new Logger({ service: "web", pretty: true });
    logger.info("request", { method: "GET", status: 200 });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("method=GET");
    expect(line).toContain("status=200");
  });

  it("pretty mode errors go to console.error", () => {
    const logger = new Logger({ service: "web", pretty: true });
    logger.error("boom");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("ERROR");
    expect(line).toContain("boom");
  });

  it("silent level suppresses all output", () => {
    const logger = new Logger({ service: "web", level: "silent" });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("nope");
    logger.error("nope");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
