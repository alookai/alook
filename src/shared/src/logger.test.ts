import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Logger } from "./logger"

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function parseLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(spy.mock.calls[0][0] as string)
}

function allLogs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string))
}

describe("Logger", () => {
  it("outputs valid JSON with level, msg, service, ts fields", () => {
    const logger = new Logger({ service: "test" })
    logger.info("hello")

    const entry = parseLog(logSpy)
    expect(entry.level).toBe("info")
    expect(entry.msg).toBe("hello")
    expect(entry.service).toBe("test")
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("includes extra context fields in output", () => {
    const logger = new Logger({ service: "test" })
    logger.info("task done", { taskId: "t1", duration: 42 })

    const entry = parseLog(logSpy)
    expect(entry.taskId).toBe("t1")
    expect(entry.duration).toBe(42)
  })

  it("filters messages below configured level", () => {
    const logger = new Logger({ service: "test", level: "warn" })
    logger.debug("hidden")
    logger.info("hidden")
    logger.warn("visible")
    logger.error("also visible")

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("writes error to console.error, others to console.log", () => {
    const logger = new Logger({ service: "test", level: "debug" })
    logger.debug("d")
    logger.info("i")
    logger.warn("w")

    expect(logSpy).toHaveBeenCalledTimes(3)
    expect(errorSpy).not.toHaveBeenCalled()

    logger.error("e")
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("silent level suppresses all output", () => {
    const logger = new Logger({ service: "test", level: "silent" })
    logger.debug("nope")
    logger.info("nope")
    logger.warn("nope")
    logger.error("nope")

    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("serializes Error objects to { message, stack }", () => {
    const logger = new Logger({ service: "test", level: "error" })
    const err = new Error("bad input")
    logger.error("failed", { err })

    const entry = parseLog(errorSpy)
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

      const entry = parseLog(logSpy)
      expect(entry.traceId).toBeUndefined()
    })

    it("allows per-call context to override child fields", () => {
      const logger = new Logger({ service: "test" })
      const child = logger.child({ requestId: "r1" })

      child.info("override", { requestId: "r2" })

      const entry = parseLog(logSpy)
      expect(entry.requestId).toBe("r2")
    })

    it("preserves service and level from parent", () => {
      const parent = new Logger({ service: "web", level: "warn" })
      const child = parent.child({ traceId: "t1" })

      child.info("should be filtered")
      child.warn("should appear")

      expect(logSpy).toHaveBeenCalledTimes(1)
      const entry = parseLog(logSpy)
      expect(entry.service).toBe("web")
    })
  })
})
