import { describe, it, expect, afterEach, vi } from "vitest"
import { markSwitch } from "./switch-mark"
import type { PerfSwitchMark } from "./perf-globals"

const origFlag = process.env.NEXT_PUBLIC_PERF_TRACE
const origNodeEnv = process.env.NODE_ENV

interface TestWindow {
  __ALOOK_PERF_MARKS__?: PerfSwitchMark[]
}

function withGlobals(flag: string | undefined, fn: (markSpy: () => void) => void): void {
  if (flag === undefined) delete process.env.NEXT_PUBLIC_PERF_TRACE
  else process.env.NEXT_PUBLIC_PERF_TRACE = flag
  ;(process.env as Record<string, string>).NODE_ENV = "development"

  const g = globalThis as unknown as { window?: TestWindow; performance?: { mark: () => void; now: () => number } }
  const prevWindow = g.window
  const prevPerf = g.performance
  const markSpy = vi.fn()
  const win: TestWindow = {}
  g.window = win
  g.performance = { mark: markSpy, now: () => 123 }
  try {
    fn(markSpy)
  } finally {
    g.window = prevWindow
    g.performance = prevPerf
  }
}

afterEach(() => {
  if (origFlag === undefined) delete process.env.NEXT_PUBLIC_PERF_TRACE
  else process.env.NEXT_PUBLIC_PERF_TRACE = origFlag
  ;(process.env as Record<string, string>).NODE_ENV = origNodeEnv ?? "test"
})

describe("markSwitch", () => {
  it("is a no-op when the flag is unset (no mark, no window mutation)", () => {
    withGlobals(undefined, (markSpy) => {
      markSwitch("channel", "chan-1")
      expect(markSpy).not.toHaveBeenCalled()
      const win = (globalThis as unknown as { window: TestWindow }).window
      expect(win.__ALOOK_PERF_MARKS__).toBeUndefined()
    })
  })

  it("writes a structured mark + buffer entry when the flag is on", () => {
    withGlobals("1", (markSpy) => {
      markSwitch("server", "srv-9")
      expect(markSpy).toHaveBeenCalledWith("alook:switch:server:srv-9")
      const win = (globalThis as unknown as { window: TestWindow }).window
      expect(win.__ALOOK_PERF_MARKS__).toHaveLength(1)
      expect(win.__ALOOK_PERF_MARKS__![0]).toMatchObject({
        kind: "server",
        id: "srv-9",
        markName: "alook:switch:server:srv-9",
      })
    })
  })
})
