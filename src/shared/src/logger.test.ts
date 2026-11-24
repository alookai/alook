import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Logger } from "./logger"

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function firstLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return spy.mock.calls[0][0] as Record<string, unknown>
}

function allLogs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
}

describe("Logger", () => {
  it("outputs a structured object with level, msg, service, ts fields", () => {
    const logger = new Logger({ service: "test" })
    logger.info("hello")

    const entry = firstLog(logSpy)
    expect(entry.level).toBe("info")
    expect(entry.msg).toBe("hello")
    expect(entry.service).toBe("test")
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("includes extra context fields in output", () => {
    const logger = new Logger({ service: "test" })
    logger.info("task done", { taskId: "t1", duration: 42 })

    const entry = firstLog(logSpy)
    expect(entry.taskId).toBe("t1")
    expect(entry.duration).toBe(42)
  })

  it("filters messages below configured level", () => {
    const logger = new Logger({ service: "test", level: "warn" })
    logger.debug("hidden")
    logger.info("hidden")
    logger.warn("visible")
    logger.error("also visible")

    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("writes error to console.error, warn to console.warn, and debug/info to console.log", () => {
    const logger = new Logger({ service: "test", level: "debug" })
    logger.debug("d")
    logger.info("i")
    logger.warn("w")

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()

    logger.error("e")
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("pretty mode formats strings and routes warn/error to matching console methods", () => {
    const logger = new Logger({ service: "test", pretty: true })
    logger.warn("careful", { code: 429 })
    logger.error("failed")

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain("WARN")
    expect(warnSpy.mock.calls[0][0]).toContain("code=429")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toContain("ERROR")
  })

  it("silent level suppresses all output", () => {
    const logger = new Logger({ service: "test", level: "silent" })
    logger.debug("nope")
    logger.info("nope")
    logger.warn("nope")
    logger.error("nope")

    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("serializes Error objects to { message, stack }", () => {
    const logger = new Logger({ service: "test", level: "error" })
    const err = new Error("bad input")
    logger.error("failed", { err })

    const entry = firstLog(errorSpy)
    const serialized = entry.err as { message: string; stack: string }
    expect(serialized.message).toBe("bad input")
    expect(serialized.stack).toContain("Error: bad input")
  })

  describe("child()", () => {
    it("merges fields into every subsequent log entry", () => {
      const logger = new Logger({ service: "test" })
      const child = logger.child({ traceId: "abc", userId: "u1" })

      child.info("hello")
      child.info("world")

      const entries = allLogs(logSpy)
      expect(entries).toHaveLength(2)
      expect(entries[0].traceId).toBe("abc")
      expect(entries[0].userId).toBe("u1")
      expect(entries[1].traceId).toBe("abc")
      expect(entries[1].userId).toBe("u1")
    })

    it("does not mutate parent logger", () => {
      const parent = new Logger({ service: "test" })
      parent.child({ traceId: "abc" })

      parent.info("parent log")

      const entry = firstLog(logSpy)
      expect(entry.traceId).toBeUndefined()
    })

    it("allows per-call context to override child fields", () => {
      const logger = new Logger({ service: "test" })
      const child = logger.child({ requestId: "r1" })

      child.info("override", { requestId: "r2" })

      const entry = firstLog(logSpy)
      expect(entry.requestId).toBe("r2")
    })

    it("preserves service and level from parent", () => {
      const parent = new Logger({ service: "web", level: "warn" })
      const child = parent.child({ traceId: "t1" })

      child.info("should be filtered")
      child.warn("should appear")

      expect(logSpy).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const entry = firstLog(warnSpy)
      expect(entry.service).toBe("web")
    })
  })
})
