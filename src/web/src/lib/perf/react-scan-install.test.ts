import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

const instrumentSpy = vi.fn(() => ({ stop: vi.fn(), isActive: () => true, subscribe: vi.fn() }))

vi.mock("react-scan/lite", () => ({ instrument: instrumentSpy }))
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const origFlag = process.env.NEXT_PUBLIC_PERF_TRACE
const origNodeEnv = process.env.NODE_ENV

interface TestWindow {
  __ALOOK_PERF_INSTALLED__?: boolean
  __ALOOK_PERF__?: unknown[]
  __ALOOK_PERF_DEGRADED__?: boolean
}

function setGate(flag: string | undefined, nodeEnv: string): void {
  if (flag === undefined) delete process.env.NEXT_PUBLIC_PERF_TRACE
  else process.env.NEXT_PUBLIC_PERF_TRACE = flag
  ;(process.env as Record<string, string>).NODE_ENV = nodeEnv
}

beforeEach(() => {
  instrumentSpy.mockClear()
  ;(globalThis as unknown as { window: TestWindow }).window = {}
})

afterEach(() => {
  setGate(origFlag, origNodeEnv ?? "test")
  delete (globalThis as unknown as { window?: TestWindow }).window
})

describe("installReactScan — gating", () => {
  it("no-ops (does not import/instrument) when the flag is off", async () => {
    setGate(undefined, "development")
    const { installReactScan } = await import("./react-scan-install")
    const handle = await installReactScan()
    expect(handle).toBeNull()
    expect(instrumentSpy).not.toHaveBeenCalled()
  })

  it("no-ops in production even with the flag on (double-gate)", async () => {
    setGate("1", "production")
    const { installReactScan } = await import("./react-scan-install")
    const handle = await installReactScan()
    expect(handle).toBeNull()
    expect(instrumentSpy).not.toHaveBeenCalled()
  })
})

describe("installReactScan — single-install guard", () => {
  it("instruments exactly once across repeated calls", async () => {
    setGate("1", "development")
    const { installReactScan, stopReactScan } = await import("./react-scan-install")

    await installReactScan()
    await installReactScan()
    await installReactScan()

    expect(instrumentSpy).toHaveBeenCalledTimes(1)
    const win = (globalThis as unknown as { window: TestWindow }).window
    expect(win.__ALOOK_PERF_INSTALLED__).toBe(true)

    // stop releases the guard so a later session can re-arm.
    stopReactScan()
    expect(win.__ALOOK_PERF_INSTALLED__).toBe(false)
    await installReactScan()
    expect(instrumentSpy).toHaveBeenCalledTimes(2)
  })
})
