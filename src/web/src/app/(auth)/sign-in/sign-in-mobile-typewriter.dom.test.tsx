import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("@/components/typewriter-visual", () => ({
  TypewriterVisual: ({ className }: { className?: string }) =>
    createElement("div", { "data-testid": "typewriter-visual-stub", className }),
}))

import { SignInMobileTypewriter } from "./sign-in-mobile-typewriter"

function mockMatchMedia({ mobile, reducedMotion = false }: { mobile: boolean; reducedMotion?: boolean }) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("max-width") ? mobile : query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
}

describe("SignInMobileTypewriter", () => {
  let rafQueue: FrameRequestCallback[] = []

  let frameTime = 0

  function flushNextFrame() {
    frameTime += 1000 / 60
    const next = rafQueue.shift()
    next?.(frameTime)
  }

  function drainFrames() {
    let guard = 0
    while (rafQueue.length > 0 && guard < 120) {
      flushNextFrame()
      guard += 1
    }
  }

  beforeEach(() => {
    rafQueue = []
    frameTime = 0
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent
    delete (window as Window & { DeviceMotionEvent?: unknown }).DeviceMotionEvent
  })

  it("mounts TypewriterVisual only on mobile when not collapsed", () => {
    mockMatchMedia({ mobile: false })
    const desktop = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    expect(screen.queryByTestId("typewriter-visual-stub")).toBeNull()
    desktop.unmount()

    mockMatchMedia({ mobile: true })
    const mobile = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    expect(screen.getByTestId("typewriter-visual-stub")).toBeVisible()
    expect(screen.getByTestId("sign-in-mobile-typewriter")).toHaveAttribute("data-collapsed", "false")

    mobile.rerender(createElement(SignInMobileTypewriter, { collapsed: true }))
    expect(screen.queryByTestId("typewriter-visual-stub")).toBeNull()
    expect(screen.getByTestId("sign-in-mobile-typewriter")).toHaveAttribute("data-collapsed", "true")
  })

  it("tilts with gyroscope orientation and shakes on accelerometer spikes before decaying to rest", () => {
    mockMatchMedia({ mobile: true })
    render(createElement(SignInMobileTypewriter, { collapsed: false }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")

    act(() => {
      const rest = new Event("deviceorientation") as DeviceOrientationEvent
      Object.defineProperties(rest, { beta: { value: 40 }, gamma: { value: 0 } })
      window.dispatchEvent(rest)

      const tilted = new Event("deviceorientation") as DeviceOrientationEvent
      Object.defineProperties(tilted, { beta: { value: 55 }, gamma: { value: 15 } })
      window.dispatchEvent(tilted)
    })

    act(() => { drainFrames() })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBeGreaterThan(-19)
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-rx"))).toBeLessThan(11)

    const beforeTx = Number.parseFloat(stage.style.getPropertyValue("--tw-tx"))
    act(() => {
      const shake = new Event("devicemotion") as DeviceMotionEvent
      Object.defineProperties(shake, {
        acceleration: { value: { x: 8, y: -5, z: 0 } },
      })
      window.dispatchEvent(shake)
      flushNextFrame()
    })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-tx"))).not.toBe(beforeTx)

    act(() => {
      drainFrames()
    })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-tx"))).toBeCloseTo(beforeTx, 1)
  })

  function orientation(beta: number, gamma: number) {
    const event = new Event("deviceorientation")
    Object.defineProperties(event, { beta: { value: beta }, gamma: { value: gamma } })
    window.dispatchEvent(event)
  }

  function motion(x: number, y: number) {
    const event = new Event("devicemotion")
    Object.defineProperty(event, "acceleration", { value: { x, y, z: 0 } })
    window.dispatchEvent(event)
  }

  function mobileStage() {
    mockMatchMedia({ mobile: true })
    const view = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 390, bottom: 240,
      width: 390, height: 240, toJSON: () => ({}),
    })
    return { stage, view }
  }

  it("coalesces sensor events into one frame and converges without snapping or overshoot", () => {
    const { stage } = mobileStage()
    act(() => {
      orientation(40, 0)
      for (let i = 1; i <= 30; i += 1) orientation(40, i)
    })
    expect(rafQueue).toHaveLength(1)
    expect(stage.style.getPropertyValue("--tw-ry")).toBe("")
    act(() => { flushNextFrame() })
    const first = Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))
    expect(first).toBeGreaterThan(-20)
    expect(first).toBeLessThan(-17)
    act(() => { drainFrames() })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBe(-4)
    expect(rafQueue).toHaveLength(0)
  })

  it("ignores small sensor noise and rejects invalid values", () => {
    const { stage } = mobileStage()
    act(() => { orientation(40, 0); drainFrames() })
    const pose = stage.style.cssText
    act(() => {
      for (let i = 0; i < 30; i += 1) orientation(40 + (i % 2 ? 0.4 : -0.4), i % 2 ? 0.4 : -0.4)
      orientation(Number.NaN, 10)
      motion(Number.POSITIVE_INFINITY, 8)
    })
    expect(rafQueue).toHaveLength(0)
    expect(stage.style.cssText).toBe(pose)
  })

  it("gives drag exclusive input and smoothly recalibrates orientation on release", () => {
    const { stage } = mobileStage()
    act(() => {
      orientation(40, 0)
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 320, clientY: 60 })
      drainFrames()
    })
    const held = stage.style.cssText
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        orientation(65, -20)
        motion(i % 2 ? 8 : -8, 5)
      }
      drainFrames()
    })
    expect(stage.style.cssText).toBe(held)
    act(() => {
      fireEvent.pointerUp(stage, { pointerId: 1 })
      orientation(65, -20)
    })
    expect(stage.style.cssText).toBe(held)
    act(() => { drainFrames() })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBe(-20)
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-rx"))).toBe(-10)
    act(() => { orientation(65, -20) })
    expect(rafQueue).toHaveLength(0)
  })

  it("does not animate reduced motion and cancels a pending frame on unmount", () => {
    mockMatchMedia({ mobile: true, reducedMotion: true })
    const reduced = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    act(() => {
      orientation(40, 0)
      motion(8, 5)
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 320, clientY: 60 })
    })
    expect(rafQueue).toHaveLength(0)
    reduced.unmount()
    const { view } = mobileStage()
    act(() => { orientation(40, 0); orientation(55, 15) })
    expect(rafQueue).toHaveLength(1)
    view.unmount()
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it("defers iOS sensor permission until releasing the typewriter stage and falls back to touch drag when denied", async () => {
    mockMatchMedia({ mobile: true })
    const requestPermission = vi.fn().mockResolvedValue("denied")
    ;(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission,
    }

    render(createElement(SignInMobileTypewriter, { collapsed: false }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 390,
      bottom: 420,
      width: 390,
      height: 420,
      toJSON: () => ({}),
    })
    expect(requestPermission).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 330, clientY: 120 })
      await Promise.resolve()
    })
    expect(requestPermission).not.toHaveBeenCalled()
    act(() => { drainFrames() })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBeGreaterThan(-19)

    await act(async () => {
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 330, clientY: 120 })
      fireEvent.pointerDown(stage, { pointerId: 2, clientX: 60, clientY: 300 })
      await Promise.resolve()
    })
    expect(requestPermission).toHaveBeenCalledOnce()
    act(() => { drainFrames() })
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBeLessThan(-19)
    await act(async () => {
      fireEvent.pointerUp(stage, { pointerId: 2 })
      await Promise.resolve()
    })
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it("reattaches sensors when permission is granted while still active", async () => {
    mockMatchMedia({ mobile: true })
    const requestOrientation = vi.fn().mockResolvedValue("granted")
    const requestMotion = vi.fn().mockResolvedValue("granted")
    ;(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission: requestOrientation,
    }
    ;(window as Window & { DeviceMotionEvent?: unknown }).DeviceMotionEvent = {
      requestPermission: requestMotion,
    }
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")
    const isSensorEvent = ([name]: readonly unknown[]) =>
      name === "deviceorientation" || name === "devicemotion"

    render(createElement(SignInMobileTypewriter, { collapsed: false }))
    act(() => {
      const motion = new Event("devicemotion")
      Object.defineProperty(motion, "acceleration", { value: { x: 1, y: 1 } })
      window.dispatchEvent(motion)
    })
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    fireEvent.pointerDown(stage, { pointerId: 9 })
    fireEvent.pointerCancel(stage, { pointerId: 9 })
    expect(requestOrientation).not.toHaveBeenCalled()
    add.mockClear()
    remove.mockClear()

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 1 })
      fireEvent.pointerUp(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requestOrientation).toHaveBeenCalledOnce()
    expect(requestMotion).toHaveBeenCalledOnce()
    expect(remove.mock.calls.filter(isSensorEvent)).toHaveLength(2)
    expect(add.mock.calls.filter(isSensorEvent)).toHaveLength(2)
  })

  it("retries after permission throws but deduplicates an in-flight request", async () => {
    mockMatchMedia({ mobile: true })
    let rejectPermission!: (error: Error) => void
    const pending = new Promise<"granted">((_resolve, reject) => { rejectPermission = reject })
    const requestPermission = vi.fn().mockReturnValueOnce(pending).mockResolvedValue("granted")
    ;(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = { requestPermission }
    render(createElement(SignInMobileTypewriter, { collapsed: false }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    const tap = () => {
      fireEvent.pointerDown(stage, { pointerId: 1 })
      fireEvent.pointerUp(stage, { pointerId: 1 })
    }
    tap()
    tap()
    expect(requestPermission).toHaveBeenCalledOnce()
    await act(async () => {
      rejectPermission(new DOMException("Gesture required", "NotAllowedError"))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { tap(); await Promise.resolve() })
    expect(requestPermission).toHaveBeenCalledTimes(2)
  })

  it("does not reattach sensors after a late permission result following unmount or collapse", async () => {
    mockMatchMedia({ mobile: true })
    const isSensorEvent = ([name]: readonly unknown[]) =>
      name === "deviceorientation" || name === "devicemotion"
    let grantUnmount!: (value: "granted") => void
    const unmountPermission = new Promise<"granted">((resolve) => {
      grantUnmount = resolve
    })
    ;(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission: vi.fn(() => unmountPermission),
    }
    const add = vi.spyOn(window, "addEventListener")
    const unmountedView = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    fireEvent.pointerDown(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 1 })
    fireEvent.pointerUp(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 1 })
    unmountedView.unmount()
    add.mockClear()
    await act(async () => {
      grantUnmount("granted")
      await unmountPermission
      await Promise.resolve()
    })
    expect(add.mock.calls.filter(isSensorEvent)).toHaveLength(0)

    let grantCollapse!: (value: "granted") => void
    const collapsePermission = new Promise<"granted">((resolve) => {
      grantCollapse = resolve
    })
    ;(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission: vi.fn(() => collapsePermission),
    }
    const collapsedView = render(createElement(SignInMobileTypewriter, { collapsed: false }))
    fireEvent.pointerDown(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 2 })
    fireEvent.pointerUp(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 2 })
    collapsedView.rerender(createElement(SignInMobileTypewriter, { collapsed: true }))
    add.mockClear()
    await act(async () => {
      grantCollapse("granted")
      await collapsePermission
      await Promise.resolve()
    })
    expect(add.mock.calls.filter(isSensorEvent)).toHaveLength(0)
    collapsedView.unmount()
  })
})
