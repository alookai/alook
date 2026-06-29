import { describe, it, expect } from "vitest";
import { createLogger } from "./logger";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const FIXED = () => "2026-06-25T12:00:00.000Z";

describe("createLogger", () => {
  it("emits `<iso> @alook/daemon <LEVEL> <message>` by default", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.info("control plane OPEN");
    expect(c.out).toEqual(["2026-06-25T12:00:00.000Z @alook/daemon INFO  control plane OPEN"]);
  });

  it("routes warn/error to stderr, info/debug to stdout", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, level: "debug", ...c.sink });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(c.out.map((l) => l.split(" ").pop())).toEqual(["d", "i"]);
    expect(c.err.map((l) => l.split(" ").pop())).toEqual(["w", "e"]);
  });

  it("suppresses below the configured level (info default drops debug)", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.debug("hidden");
    log.info("shown");
    expect(c.out).toHaveLength(1);
    expect(c.out[0]).toContain("shown");
  });

  it("supports a sub-tagged child header", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink }).child("daemon");
    log.info("up");
    expect(c.out[0]).toBe("2026-06-25T12:00:00.000Z @alook/daemon:daemon INFO  up");
  });

  it("honors a custom header", () => {
    const c = capture();
    const log = createLogger({ header: "@alook/daemon:daemon", now: FIXED, ...c.sink });
    log.warn("careful");
    expect(c.err[0]).toBe("2026-06-25T12:00:00.000Z @alook/daemon:daemon WARN  careful");
  });

  it("formats object args as key=value pairs", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.info("agent spawned", { agentId: "ag_1", pid: 1234 });
    expect(c.out[0]).toContain("agent spawned agentId=ag_1 pid=1234");
  });

  it("formats Error args as err=<message>", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.error("spawn failed", new Error("ENOENT"));
    expect(c.out.length).toBe(0);
    expect(c.err[0]).toContain("spawn failed err=ENOENT");
  });

  it("stringifies non-object args directly", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.info("count", 42);
    expect(c.out[0]).toContain("count 42");
  });

  it("handles multiple mixed data args", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.info("result", { ok: true }, "extra");
    expect(c.out[0]).toContain("result ok=true extra");
  });

  it("works with no data args (backward compatible)", () => {
    const c = capture();
    const log = createLogger({ now: FIXED, ...c.sink });
    log.info("plain message");
    expect(c.out[0]).toBe("2026-06-25T12:00:00.000Z @alook/daemon INFO  plain message");
  });
});
