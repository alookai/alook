import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import { useScriptedTimeline } from "./use-scripted-timeline"

const steps = [{ id: "request", duration: 100 }, { id: "answer", duration: 200 }]
let intersect: (active: boolean) => void
let motion: (reduced: boolean) => void
let reduced = false
let observers: Array<{ targets: Set<Element> }> = []
let mediaQueries: Array<Set<(event: MediaQueryListEvent) => void>> = []

function Demo() {
  const timeline = useScriptedTimeline({ steps, holdAfterComplete: 1000, resetDuration: 100 })
  return createElement("div", { ref: timeline.containerRef, "data-testid": "demo", "data-resetting": timeline.isResetting },
    steps.filter(step => timeline.isStepVisible(step.id)).map((step) => createElement("p", { key: step.id }, step.id)))
}

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  observers = []
  mediaQueries = []
  vi.stubGlobal("matchMedia", () => {
    const callbacks = new Set<(event: MediaQueryListEvent) => void>()
    mediaQueries.push(callbacks)
    const query = {
      matches: reduced,
      addEventListener: (type: string, callback: (event: MediaQueryListEvent) => void) => {
        if (type === "change") callbacks.add(callback)
      },
      removeEventListener: (type: string, callback: (event: MediaQueryListEvent) => void) => {
        if (type === "change") callbacks.delete(callback)
      },
    }
    motion = (matches) => {
      query.matches = matches
      for (const callback of Array.from(callbacks)) callback({ matches } as MediaQueryListEvent)
    }
    return query
  })
  vi.stubGlobal("IntersectionObserver", class {
    targets = new Set<Element>()
    constructor(callback: IntersectionObserverCallback) {
      observers.push(this)
      intersect = (isIntersecting) => {
        if (!this.targets.size) return
        const entries = Array.from(this.targets, (target) => ({ target, isIntersecting }))
        callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
      }
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("scripted demo timeline", () => {
  it("reveals steps only in view, holds the result and restarts after its fade", () => {
    const view = render(createElement(Demo))
    const target = view.container.firstElementChild!
    expect(observers.some((observer) => observer.targets.has(target))).toBe(true)
    expect(mediaQueries.some((callbacks) => callbacks.size > 0)).toBe(true)
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
    const activeObservers = observers.filter((observer) => observer.targets.has(target))
    const activeMediaQueries = mediaQueries.filter((callbacks) => callbacks.size > 0)
    expect(activeObservers.length).toBeGreaterThan(0)
    expect(activeMediaQueries.length).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(activeObservers.flatMap((observer) => Array.from(observer.targets))).toEqual([])
    expect(activeMediaQueries.flatMap((callbacks) => Array.from(callbacks))).toEqual([])
  })

  it("shows the complete demo immediately for reduced motion", () => {
    reduced = true
    const view = render(createElement(Demo))
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.getByText("answer")).toBeVisible()
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "false")
    expect(vi.getTimerCount()).toBe(0)
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
    expect(screen.getByText("request")).toBeVisible()
    expect(screen.getByText("answer")).toBeVisible()
    expect(screen.getByTestId("demo")).toHaveAttribute("data-resetting", "false")
    expect(vi.getTimerCount()).toBe(0)
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
