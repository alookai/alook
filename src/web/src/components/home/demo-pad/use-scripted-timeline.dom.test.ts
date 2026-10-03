import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import { useScriptedTimeline } from "./use-scripted-timeline"

const steps = [{ id: "request", duration: 100 }, { id: "answer", duration: 200 }]
let intersect: (active: boolean) => void
let motion: (reduced: boolean) => void
let reduced = false
const disconnect = vi.fn()
const removeListener = vi.fn()

function Demo() {
  const timeline = useScriptedTimeline({ steps, holdAfterComplete: 1000, resetDuration: 100 })
  return createElement("div", { ref: timeline.containerRef, "data-testid": "demo", "data-resetting": timeline.isResetting },
    steps.filter((_, index) => timeline.isStepVisible(index)).map((step) => createElement("p", { key: step.id }, step.id)))
}

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  disconnect.mockClear()
  removeListener.mockClear()
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: (_: string, callback: (event: MediaQueryListEvent) => void) => {
      motion = (matches) => callback({ matches } as MediaQueryListEvent)
    },
    removeEventListener: removeListener,
  }))
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = (isIntersecting) => callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe() {}
    disconnect = disconnect
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("scripted demo timeline", () => {
  it("reveals steps only in view, holds the result and restarts after its fade", () => {
    const view = render(createElement(Demo))
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.queryByText("request")).toBeNull()
    act(() => intersect(true))
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.queryByText("answer")).toBeNull()
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByText("answer")).toBeVisible()
    act(() => vi.advanceTimersByTime(1200))
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "true")
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "false")
    expect(screen.queryByText("request")).toBeNull()
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByText("request")).toBeVisible()
    act(() => intersect(false))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText("answer")).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function))
  })

  it("shows the complete demo immediately for reduced motion", () => {
    reduced = true
    const view = render(createElement(Demo))
    act(() => intersect(true))
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.getByText("answer")).toBeVisible()
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "false")
    expect(vi.getTimerCount()).toBe(0)
    view.unmount()
  })

  it("cancels the running cycle when reduced motion is enabled and resumes when disabled", () => {
    const view = render(createElement(Demo))
    act(() => intersect(true))
    act(() => vi.advanceTimersByTime(500))
    act(() => motion(true))
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.getByText("answer")).toBeVisible()
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "false")
    expect(vi.getTimerCount()).toBe(0)
    act(() => motion(false))
    expect(screen.queryByText("request")).toBeNull()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.queryByText("answer")).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
