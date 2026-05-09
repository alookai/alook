import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "./logger.js";

let stdoutSpy: any;
let stderrSpy: any;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NO_COLOR;
});

describe("Logger", () => {
  it("filters messages below configured level", () => {
    const logger = new Logger({ level: "warn" });
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("visible");
    logger.error("visible");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("formats output with timestamp and level prefix", () => {
    const logger = new Logger({ level: "debug" });
    logger.info("hello world");

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO  hello world\n$/);
  });

  it("writes error level to stderr", () => {
    const logger = new Logger({ level: "error" });
    logger.error("something broke");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/ERROR something broke/);
  });

  it("writes debug/info/warn to stdout", () => {
    const logger = new Logger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");

    expect(stdoutSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("respects NO_COLOR environment variable", () => {
    process.env.NO_COLOR = "1";
    const logger = new Logger({ level: "info" });
    logger.info("no colors");

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("\x1b[");
  });

  it("includes extra args on subsequent lines", () => {
    const logger = new Logger({ level: "error" });
    logger.error("failed", new Error("bad input"));

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const extra = stderrSpy.mock.calls[1][0] as string;
    expect(extra).toBe("  bad input\n");
  });

  it("silent level suppresses all output", () => {
    const logger = new Logger({ level: "silent" });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("nope");
    logger.error("nope");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("setLevel changes level at runtime", () => {
    const logger = new Logger({ level: "error" });
    logger.info("hidden");
    expect(stdoutSpy).not.toHaveBeenCalled();

    logger.setLevel("debug");
    logger.info("visible");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("includes module prefix in output", () => {
    const logger = new Logger({ level: "info", module: "test-mod" });
    logger.info("hello");

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("[test-mod]");
    expect(output).toContain("hello");
  });

  it("child creates logger with module prefix", () => {
    const parent = new Logger({ level: "info" });
    const child = parent.child("child-mod");
    child.info("from child");

    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain("[child-mod]");
  });

  it("formats object args as key=value pairs", () => {
    const logger = new Logger({ level: "info" });
    logger.info("ctx test", { foo: "bar", num: 42 });

    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    const extra = stdoutSpy.mock.calls[1][0] as string;
    expect(extra).toContain("foo=bar");
    expect(extra).toContain("num=42");
  });
});
