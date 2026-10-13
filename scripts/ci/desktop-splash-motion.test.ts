import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { DURATION, REDUCED_MOTION_FRAME, motionAt } from "../../src/web/src/components/brand/alook-loading/motion.js"

const repoRoot = resolve(import.meta.dirname, "../..")
const source = await readFile(resolve(repoRoot, "src/desktop/src-tauri/src/commands.rs"), "utf8")
const clockStart = source.indexOf('const media=window.matchMedia("(prefers-reduced-motion: reduce)");')
const clockEnd = source.indexOf("</script></body></html>", clockStart)
if (clockStart < 0 || clockEnd < 0) throw new Error("Desktop splash clock was not found")
const clock = source.slice(clockStart, clockEnd)

function createClock({ reduced = false, hidden = false } = {}) {
  const callbacks = new Map<number, (timestamp: number) => void>()
  const listeners = new Map<string, () => void>()
  const samples: { frame: number; motion: ReturnType<typeof motionAt> }[] = []
  const requestedFrames: (number | undefined)[] = []
  let nextRequest = 0
  const media = {
    matches: reduced,
    addEventListener: (event: string, listener: () => void) => listeners.set(`media:${event}`, listener),
  }
  const document = {
    hidden,
    addEventListener: (event: string, listener: () => void) => listeners.set(`document:${event}`, listener),
  }
  runInNewContext(clock, {
    window: { matchMedia: () => media },
    document,
    DURATION,
    REDUCED_MOTION_FRAME,
    apply: (frame: number) => samples.push({ frame, motion: motionAt(frame) }),
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      requestedFrames.push(samples.at(-1)?.frame)
      const request = ++nextRequest
      callbacks.set(request, callback)
      return request
    },
    cancelAnimationFrame: (request: number) => callbacks.delete(request),
  })
  function emit(event: string) {
    const listener = listeners.get(event)
    if (!listener) throw new Error(`Missing listener: ${event}`)
    listener()
  }
  return {
    samples,
    requestedFrames,
    get pending() { return callbacks.size },
    get current() {
      const sample = samples.at(-1)
      if (!sample) throw new Error("No splash frame was applied")
      return sample
    },
    advance(timestamp: number) {
      expect(callbacks.size).toBe(1)
      const entry = callbacks.entries().next().value
      if (!entry) throw new Error("No animation request was pending")
      const [request, callback] = entry
      callbacks.delete(request)
      callback(timestamp)
    },
    setReduced(value: boolean) {
      media.matches = value
      emit("media:change")
    },
    setHidden(value: boolean) {
      document.hidden = value
      emit("document:visibilitychange")
    },
  }
}

describe("desktop splash motion clock", () => {
  it("applies the first active curve phase before requesting animation and advances with time", () => {
    const splash = createClock()
    expect(splash.samples).toEqual([{ frame: 61, motion: motionAt(61) }])
    expect(splash.requestedFrames).toEqual([61])
    expect(splash.current.motion).not.toEqual(motionAt(0))
    expect(splash.pending).toBe(1)
    splash.advance(0)
    expect(splash.current.frame).toBe(61)
    splash.advance(17)
    expect(splash.current.frame).toBe(62)
    expect(splash.current.motion.orbit).toBeGreaterThan(motionAt(61).orbit)
    expect(splash.pending).toBe(1)
  })

  it("uses elapsed time rather than callback count at 60 and 120 Hz", () => {
    const sixty = createClock()
    const oneTwenty = createClock()
    for (const timestamp of [0, 17, 34]) sixty.advance(timestamp)
    for (const timestamp of [0, 8.5, 17, 25.5, 34]) oneTwenty.advance(timestamp)
    expect(sixty.current.frame).toBe(63)
    expect(oneTwenty.current).toEqual(sixty.current)
    expect(sixty.pending).toBe(1)
    expect(oneTwenty.pending).toBe(1)
  })

  it("keeps reduced motion at the complete frame and resumes the retained active progress", () => {
    const splash = createClock({ reduced: true })
    expect(splash.current).toEqual({ frame: 0, motion: motionAt(0) })
    expect(splash.pending).toBe(0)
    splash.setReduced(false)
    expect(splash.current.frame).toBe(61)
    splash.advance(0)
    splash.advance(50)
    const progress = splash.current
    expect(progress.frame).toBe(64)
    splash.setReduced(true)
    expect(splash.current).toEqual({ frame: 0, motion: motionAt(0) })
    expect(splash.pending).toBe(0)
    splash.setReduced(true)
    expect(splash.pending).toBe(0)
    splash.setReduced(false)
    expect(splash.current).toEqual(progress)
    expect(splash.pending).toBe(1)
    splash.advance(10_000)
    expect(splash.current).toEqual(progress)
    splash.advance(10_017)
    expect(splash.current.frame).toBe(65)
  })

  it("pauses while hidden without accumulating hidden time or resetting the current phase", () => {
    const splash = createClock()
    splash.advance(0)
    splash.advance(50)
    const progress = splash.current
    splash.setHidden(true)
    expect(splash.current).toEqual(progress)
    expect(splash.pending).toBe(0)
    splash.setHidden(false)
    expect(splash.current).toEqual(progress)
    expect(splash.pending).toBe(1)
    splash.setHidden(false)
    expect(splash.pending).toBe(1)
    splash.advance(10_000)
    expect(splash.current).toEqual(progress)
    splash.advance(10_017)
    expect(splash.current.frame).toBe(65)
    expect(splash.pending).toBe(1)
  })

  it("does not request animation when initially hidden or when reduced motion changes while hidden", () => {
    const splash = createClock({ hidden: true })
    expect(splash.current.frame).toBe(61)
    expect(splash.pending).toBe(0)
    splash.setReduced(true)
    expect(splash.current.frame).toBe(0)
    expect(splash.pending).toBe(0)
    splash.setReduced(false)
    expect(splash.current.frame).toBe(61)
    expect(splash.pending).toBe(0)
    splash.setHidden(false)
    expect(splash.pending).toBe(1)
    splash.advance(20_000)
    expect(splash.current.frame).toBe(61)
    splash.advance(20_017)
    expect(splash.current.frame).toBe(62)
  })

  it("retains the original nine-second loop with the desktop phase offset", () => {
    const splash = createClock()
    const initial = splash.current
    expect(DURATION).toBe(540)
    splash.advance(0)
    splash.advance(9_000)
    expect(splash.current).toEqual(initial)
    splash.advance(9_017)
    expect(splash.current.frame).toBe(62)
    expect(splash.pending).toBe(1)
  })
})
