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

  function flushNextFrame(ts = 16) {
    const next = rafQueue.shift()
    next?.(ts)
  }

  function drainFrames() {
    let guard = 0
    while (rafQueue.length > 0 && guard < 120) {
      flushNextFrame(16 * (guard + 1))
      guard += 1
    }
  }

  beforeEach(() => {
    rafQueue = []
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

  it("defers iOS sensor permission until tapping the typewriter stage and falls back to touch drag when denied", async () => {
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
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBeGreaterThan(-19)

    await act(async () => {
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 330, clientY: 120 })
      fireEvent.pointerDown(stage, { pointerId: 2, clientX: 60, clientY: 300 })
      await Promise.resolve()
    })
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(Number.parseFloat(stage.style.getPropertyValue("--tw-ry"))).toBeLessThan(-19)
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
    add.mockClear()
    remove.mockClear()

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("sign-in-mobile-typewriter"), { pointerId: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requestOrientation).toHaveBeenCalledOnce()
    expect(requestMotion).toHaveBeenCalledOnce()
    expect(remove.mock.calls.filter(isSensorEvent)).toHaveLength(2)
    expect(add.mock.calls.filter(isSensorEvent)).toHaveLength(2)
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
