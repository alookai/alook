import { afterEach, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { useReducedMotion } from "./use-reduced-motion"

afterEach(() => vi.unstubAllGlobals())
it("reads the current preference, follows changes, and releases its own listener", () => {
  const media = { matches: true, addEventListener: vi.fn((_event: string, _listener: () => void) => {}), removeEventListener: vi.fn((_event: string, _listener: () => void) => {}) }
  vi.stubGlobal("matchMedia", vi.fn(() => media))
  const hook = renderHook(() => useReducedMotion())
  expect(hook.result.current).toBe(true)
  const [event, sync] = media.addEventListener.mock.calls[0]
  expect(event).toBe("change")
  act(() => { media.matches = false; sync() })
  expect(hook.result.current).toBe(false)
  hook.unmount()
  expect(media.removeEventListener).toHaveBeenCalledExactlyOnceWith("change", sync)
})
