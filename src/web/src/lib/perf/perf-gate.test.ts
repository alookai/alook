import { describe, it, expect, afterEach } from "vitest"
import { perfTraceEnabled } from "./perf-gate"

const origFlag = process.env.NEXT_PUBLIC_PERF_TRACE
const origNodeEnv = process.env.NODE_ENV

function setEnv(flag: string | undefined, nodeEnv: string): void {
  if (flag === undefined) delete process.env.NEXT_PUBLIC_PERF_TRACE
  else process.env.NEXT_PUBLIC_PERF_TRACE = flag
  // NODE_ENV is readonly in the types but writable at runtime under vitest.
  ;(process.env as Record<string, string>).NODE_ENV = nodeEnv
}

afterEach(() => {
  setEnv(origFlag, origNodeEnv ?? "test")
})

describe("perfTraceEnabled — double gate", () => {
  it("is on only when flag=1 AND not production", () => {
    setEnv("1", "development")
    expect(perfTraceEnabled()).toBe(true)
  })

  it("is off when the flag is unset even in dev", () => {
    setEnv(undefined, "development")
    expect(perfTraceEnabled()).toBe(false)
  })

  it("is off in production even when the flag is 1 (hard backstop)", () => {
    setEnv("1", "production")
    expect(perfTraceEnabled()).toBe(false)
  })

  it("is off for any non-'1' flag value", () => {
    setEnv("true", "development")
    expect(perfTraceEnabled()).toBe(false)
  })
})
