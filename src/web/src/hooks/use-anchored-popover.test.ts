import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  anchoredPopoverStyle,
  readVisualViewport,
  subscribeAnchoredPopoverChanges,
  type AnchorRect,
  type VisualViewportRect,
} from "./use-anchored-popover"

const VIEWPORT: VisualViewportRect = { top: 100, left: 20, width: 320, height: 500 }

function rect(top: number, left: number, height = 16): AnchorRect {
  return { top, bottom: top + height, left, right: left + 4 }
}

describe("anchoredPopoverStyle", () => {
  it("converts visual coordinates to layout-fixed coordinates exactly once", () => {
    const style = anchoredPopoverStyle(rect(400, 40), VIEWPORT, 256, 240)
    expect(style.top).toBe(496)
    expect(style.left).toBe(60)
    expect(Number(style.top) - VIEWPORT.top).toBe(396)
    expect(Number(style.left) - VIEWPORT.left).toBe(40)
    expect(style.transform).toBe("translateY(-100%)")
    expect(style["--anchored-popover-max-height"]).toBe("240px")
  })

  it("flips below a caret near the visual viewport top", () => {
    const style = anchoredPopoverStyle(rect(20, 40), VIEWPORT, 256, 240)
    expect(style.top).toBe(140)
    expect(Number(style.top) - VIEWPORT.top).toBe(40)
    expect(style.transform).toBeUndefined()
  })

  it("clamps both horizontal edges against a non-zero visual viewport origin", () => {
    expect(anchoredPopoverStyle(rect(400, -100), VIEWPORT, 256, 240).left).toBe(28)
    expect(anchoredPopoverStyle(rect(400, 500), VIEWPORT, 256, 240).left).toBe(76)
  })

  it("uses the roomier side and reduces list height when neither side fully fits", () => {
    const shortViewport = { top: 100, left: 0, width: 320, height: 220 }
    const style = anchoredPopoverStyle(rect(80, 20), shortViewport, 256, 240)
    expect(style.transform).toBeUndefined()
    expect(style["--anchored-popover-max-height"]).toBe("102px")
  })

  it("keeps zero-offset desktop geometry unchanged", () => {
    const style = anchoredPopoverStyle(
      rect(400, 40),
      { top: 0, left: 0, width: 320, height: 500 },
      256,
      240,
    )
    expect(style.top).toBe(396)
    expect(style.left).toBe(40)
    expect(style.transform).toBe("translateY(-100%)")
  })
})

describe("visual viewport refresh signals", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  let windowListeners: Map<string, Set<EventListener>>
  let viewportListeners: Map<string, Set<EventListener>>
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  const eventTarget = (listeners: Map<string, Set<EventListener>>) => ({
    addEventListener(type: string, listener: EventListener) {
      const current = listeners.get(type) ?? new Set<EventListener>()
      current.add(listener)
      listeners.set(type, current)
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener)
    },
  })

  beforeEach(() => {
    vi.useFakeTimers()
    windowListeners = new Map()
    viewportListeners = new Map()
    frames = new Map()
    nextFrame = 1
    const viewportTarget = eventTarget(viewportListeners)
    const windowTarget = eventTarget(windowListeners)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...windowTarget,
        innerWidth: 1024,
        innerHeight: 768,
        visualViewport: {
          ...viewportTarget,
          offsetTop: 100,
          offsetLeft: 20,
          width: 320,
          height: 500,
        },
        requestAnimationFrame(callback: FrameRequestCallback) {
          const id = nextFrame++
          frames.set(id, callback)
          return id
        },
        cancelAnimationFrame(id: number) {
          frames.delete(id)
        },
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  })

  const dispatch = (listeners: Map<string, Set<EventListener>>, type: string) => {
    for (const listener of listeners.get(type) ?? []) listener(new Event(type))
  }

  const flushFrame = () => {
    const entries = [...frames.entries()]
    frames.clear()
    for (const [, callback] of entries) callback(0)
  }

  it("reads visual viewport offsets instead of assuming a zero-origin layout viewport", () => {
    expect(readVisualViewport()).toEqual(VIEWPORT)
  })

  it("refreshes on visual viewport and capture-scroll changes, including a trailing keyboard settle", () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeAnchoredPopoverChanges(onChange)

    dispatch(viewportListeners, "resize")
    flushFrame()
    expect(onChange).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(200)
    flushFrame()
    expect(onChange).toHaveBeenCalledTimes(2)

    dispatch(windowListeners, "scroll")
    flushFrame()
    expect(onChange).toHaveBeenCalledTimes(3)

    unsubscribe()
    dispatch(viewportListeners, "scroll")
    flushFrame()
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
