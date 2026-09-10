import React from "react"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { AlookLoading } from "./AlookLoading"

describe("AlookLoading playback lifecycle", () => {
  let frames: Map<number, FrameRequestCallback>
  let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
  let listeners: Set<() => void>
  let intersection: IntersectionObserverCallback
  let disconnect: ReturnType<typeof vi.fn>
  let observe: ReturnType<typeof vi.fn>
  let hidden = false

  beforeEach(() => {
    frames = new Map()
    listeners = new Set()
    let id = 0
    hidden = false
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.set(++id, callback)
      return id
    }))
    vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => frames.delete(frame)))
    media = {
      matches: false,
      addEventListener: vi.fn((_type: string, callback: () => void) => listeners.add(callback)),
      removeEventListener: vi.fn((_type: string, callback: () => void) => listeners.delete(callback)),
    }
    vi.stubGlobal("matchMedia", vi.fn(() => media))
    disconnect = vi.fn()
    observe = vi.fn()
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersection = callback }
      observe = observe
      disconnect = disconnect
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const tick = (time: number) => act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(time))
  })
  const intersect = (visible: boolean) => act(() => {
    intersection([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
  const reduce = (value: boolean) => act(() => {
    media.matches = value
    listeners.forEach(callback => callback())
  })
  const visibility = (value: boolean) => act(() => {
    hidden = value
    document.dispatchEvent(new Event("visibilitychange"))
  })

  it("advances the shared artwork and wraps exactly at nine seconds", () => {
    const view = render(React.createElement(AlookLoading))
    const initial = view.container.innerHTML
    expect(observe).toHaveBeenCalledWith(view.getByRole("status"))
    expect(view.getByRole("status")).toHaveAttribute("aria-label", "Loading")
    tick(0)
    tick(2500)
    expect(view.container.innerHTML).not.toBe(initial)
    expect(view.container.innerHTML).toContain("round 152.109375px")
    tick(6500)
    expect(view.container.innerHTML).not.toBe(initial)
    tick(7500)
    expect(view.container.innerHTML).not.toBe(initial)
    tick(9000)
    expect(view.container.innerHTML).toBe(initial)
    expect(frames.size).toBe(1)
  })

  it("freezes paused playback and resumes without counting paused time", () => {
    const view = render(React.createElement(AlookLoading, { size: 192, label: "Connecting", className: "preview" }))
    expect(view.getByRole("status")).toHaveStyle({ width: "192px", height: "192px" })
    expect(view.getByRole("status")).toHaveClass("preview")
    tick(0)
    tick(1000)
    view.rerender(React.createElement(AlookLoading, { paused: true }))
    const frozen = view.container.innerHTML
    expect(frames.size).toBe(0)
    tick(3000)
    expect(view.container.innerHTML).toBe(frozen)
    view.rerender(React.createElement(AlookLoading))
    tick(4000)
    expect(view.container.innerHTML).toBe(frozen)
    tick(4250)
    expect(view.container.innerHTML).not.toBe(frozen)
  })

  it("suspends offscreen and hidden tabs without skipping ahead on return", () => {
    const view = render(React.createElement(AlookLoading))
    tick(0)
    tick(500)
    const before = view.container.innerHTML
    intersect(false)
    expect(frames.size).toBe(0)
    tick(2000)
    expect(view.container.innerHTML).toBe(before)
    intersect(true)
    tick(3000)
    expect(view.container.innerHTML).toBe(before)
    tick(3200)
    expect(view.container.innerHTML).not.toBe(before)
    visibility(true)
    const hiddenFrame = view.container.innerHTML
    expect(frames.size).toBe(0)
    tick(5000)
    visibility(false)
    tick(6000)
    expect(view.container.innerHTML).toBe(hiddenFrame)
    tick(6250)
    expect(view.container.innerHTML).not.toBe(hiddenFrame)
  })

  it("shows a static logo for reduced motion and removes every subscription on unmount", () => {
    media.matches = true
    const remove = vi.spyOn(document, "removeEventListener")
    const view = render(React.createElement(AlookLoading))
    expect(frames.size).toBe(0)
    expect(view.container.innerHTML).toContain("round 152.109375px")
    reduce(false)
    expect(frames.size).toBe(1)
    tick(0)
    tick(100)
    reduce(true)
    expect(frames.size).toBe(0)
    expect(view.container.innerHTML).toContain("round 152.109375px")
    reduce(false)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
  })
})
