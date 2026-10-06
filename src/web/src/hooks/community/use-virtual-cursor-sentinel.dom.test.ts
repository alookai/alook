import { createElement, useCallback, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { useVirtualCursorSentinel } from "./use-virtual-cursor-sentinel"

type Props = {
  showSentinel?: boolean
  elementRevision?: number
  rootRevision?: number
  edge: "start" | "end"
  hasMore: boolean
  isFetching: boolean
  isSettling?: boolean
  onBeforeLoad?: () => void
  onLoad: () => void
}

let intersectionCallback: IntersectionObserverCallback
let disconnect: ReturnType<typeof vi.fn>
let observed: Element | undefined

function Harness(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useVirtualCursorSentinel({ scrollRef, ...props })
  const bindRoot = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node }, [])
  return createElement(
    "div",
    // eslint-disable-next-line react-hooks/refs -- React DOM invokes these ref callbacks during commit.
    { "data-testid": "scroll", key: props.rootRevision ?? 0, ref: bindRoot },
    props.showSentinel === false ? null : createElement("div", { "data-testid": "sentinel", key: props.elementRevision ?? 0, ref: sentinelRef }),
  )
}

function renderView(props: Props) {
  const rendered = render(createElement(Harness, props))
  return {
    rerender: (next: Props) => rendered.rerender(createElement(Harness, next)),
    unmount: rendered.unmount,
  }
}

function intersect(isIntersecting: boolean) {
  act(() => {
    intersectionCallback(
      [{ isIntersecting, target: observed } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  })
}

describe.each(["start", "end"] as const)("useVirtualCursorSentinel (%s edge)", (edge) => {
  beforeEach(() => {
    disconnect = vi.fn()
    observed = undefined
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe(element: Element) { observed = element }
      disconnect() { disconnect() }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("loads on a true intersection and ignores false entries", () => {
    const onLoad = vi.fn()
    renderView({ edge, hasMore: true, isFetching: false, onLoad })

    intersect(false)
    expect(onLoad).not.toHaveBeenCalled()
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it("drops input while busy and requires fresh same-direction input after settle", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const view = renderView({ edge, hasMore: true, isFetching: false, onLoad })
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()

    view.rerender({ edge, hasMore: true, isFetching: true, onLoad })
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender({ edge, hasMore: true, isFetching: false, onLoad })
    expect(onLoad).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(181))
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("waits for anchor settlement before accepting the next demand", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const view = renderView({ edge, hasMore: true, isFetching: false, onLoad })
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()

    view.rerender({ edge, hasMore: true, isFetching: true, onLoad })
    view.rerender({ edge, hasMore: true, isFetching: false, onLoad, isSettling: true })
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledOnce()

    view.rerender({ edge, hasMore: true, isFetching: false, onLoad, isSettling: false })
    act(() => vi.advanceTimersByTime(181))
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("does not accept a second page before the active touch gesture ends", () => {
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, isSettling: false, onLoad }
    const view = renderView(base)
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!

    fireEvent.touchStart(scroll, { touches: [{ clientY: 100 }] })
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()

    view.rerender({ ...base, isFetching: true, isSettling: true })
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 130 : 70 }] })
    view.rerender(base)

    // This is still the same physical gesture: no touchend/new touchstart occurred.
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 160 : 40 }] })
    expect(onLoad).toHaveBeenCalledOnce()

    fireEvent.touchEnd(scroll, { touches: [] })
    fireEvent.touchStart(scroll, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 130 : 70 }] })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("treats trackpad momentum as one wheel gesture until input goes idle", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    intersect(true)

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(2)

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -10 : 10 })
    expect(onLoad).toHaveBeenCalledTimes(2)

    act(() => vi.advanceTimersByTime(181))
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(3)
  })

  it("treats keyboard repeat as one key gesture until keyup", () => {
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const key = edge === "start" ? "PageUp" : "PageDown"
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    intersect(true)

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(2)

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    fireEvent.keyDown(scroll, { key, repeat: true })
    expect(onLoad).toHaveBeenCalledTimes(2)

    fireEvent.keyUp(scroll, { key })
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(3)
  })

  it("ignores navigation keys while focus is outside the scroller", () => {
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const key = edge === "start" ? "PageUp" : "PageDown"
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    const outside = document.createElement("button")
    document.body.append(outside)
    intersect(true)
    view.rerender({ ...base, isFetching: true })
    view.rerender(base)

    outside.focus()
    fireEvent.keyDown(outside, { key })
    expect(onLoad).toHaveBeenCalledOnce()

    scroll.tabIndex = -1
    scroll.focus()
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(2)
    outside.remove()
  })

  it("clears held key, touch, wheel, and timer state on window blur", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const key = edge === "start" ? "PageUp" : "PageDown"
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    intersect(true)
    view.rerender({ ...base, isFetching: true })
    view.rerender(base)

    fireEvent.wheel(scroll, { deltaY: edge === "start" ? 20 : -20 })
    fireEvent.touchStart(scroll, { touches: [{ clientY: 100 }] })
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    view.rerender({ ...base, isFetching: true })
    view.rerender(base)

    act(() => window.dispatchEvent(new Event("blur")))
    expect(vi.getTimerCount()).toBe(0)

    // No keyup is needed after blur: the next press is a fresh gesture.
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(3)
    view.rerender({ ...base, isFetching: true })
    view.rerender(base)

    // The pre-blur touch no longer has a live coordinate, while wheel is fresh.
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 130 : 70 }] })
    expect(onLoad).toHaveBeenCalledTimes(3)
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(4)
  })

  it("accepts only fresh input toward the active edge", () => {
    const calls: string[] = []
    const onBeforeLoad = () => calls.push("before")
    const onLoad = () => calls.push("load")
    const base = { edge, hasMore: true, isFetching: false, onBeforeLoad, onLoad }
    const view = renderView(base)
    intersect(true)
    expect(calls).toEqual(["before", "load"])

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? 20 : -20 })
    fireEvent.keyDown(scroll, { key: edge === "start" ? "ArrowDown" : "ArrowUp" })
    expect(calls).toHaveLength(2)

    fireEvent.keyDown(scroll, { key: edge === "start" ? "PageUp" : "PageDown" })
    expect(calls).toEqual(["before", "load", "before", "load"])

    view.rerender({ ...base, isFetching: true })
    view.rerender(base)
    fireEvent.touchStart(scroll, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 130 : 70 }] })
    expect(calls).toEqual(["before", "load", "before", "load", "before", "load"])
  })

  it("clears pending demand when hasMore becomes false and disconnects on unmount", () => {
    const onLoad = vi.fn()
    const view = renderView({ edge, hasMore: true, isFetching: true, onLoad })
    intersect(true)
    view.rerender({ edge, hasMore: false, isFetching: false, onLoad })
    expect(onLoad).not.toHaveBeenCalled()

    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it("preserves the demanded intersection and rejects the detached observer callback", () => {
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    intersect(true)
    const retiredCallback = intersectionCallback
    const retiredElement = observed
    view.rerender({ ...base, isFetching: true, showSentinel: false })
    view.rerender({ ...base, elementRevision: 1 })
    act(() => retiredCallback([{ isIntersecting: false, target: retiredElement } as IntersectionObserverEntry], {} as IntersectionObserver))
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()
    intersect(false)
    intersect(true)
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("keeps the load locked through detach until its fetch is actually observed", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    intersect(true)
    view.rerender({ ...base, showSentinel: false })
    view.rerender({ ...base, elementRevision: 1 })
    intersect(false)
    intersect(true)
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender({ ...base, isFetching: true, elementRevision: 1 })
    view.rerender({ ...base, elementRevision: 1 })
    act(() => vi.advanceTimersByTime(181))
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("preserves held keys, touch budget, and wheel idle timer across element replacement", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const scroll = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    const key = edge === "start" ? "PageUp" : "PageDown"
    fireEvent.touchStart(scroll, { touches: [{ clientY: 100 }] })
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    fireEvent.keyDown(scroll, { key })
    intersect(true)
    view.rerender({ ...base, isFetching: true, showSentinel: false })
    view.rerender({ ...base, elementRevision: 1 })
    intersect(true)
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.keyDown(scroll, { key })
    fireEvent.touchMove(scroll, { touches: [{ clientY: edge === "start" ? 130 : 70 }] })
    fireEvent.wheel(scroll, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledOnce()
    fireEvent.keyUp(scroll, { key })
    fireEvent.keyDown(scroll, { key })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("retires the root timer and gesture listeners when the actual scroller is replaced", () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const base = { edge, hasMore: true, isFetching: false, onLoad }
    const view = renderView(base)
    const oldRoot = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(oldRoot, { deltaY: edge === "start" ? 20 : -20 })
    expect(vi.getTimerCount()).toBe(1)
    view.rerender({ ...base, rootRevision: 1 })
    expect(vi.getTimerCount()).toBe(0)
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender({ ...base, rootRevision: 1, isFetching: true })
    view.rerender({ ...base, rootRevision: 1 })
    fireEvent.wheel(oldRoot, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledOnce()
    const current = document.querySelector<HTMLElement>('[data-testid="scroll"]')!
    fireEvent.wheel(current, { deltaY: edge === "start" ? -20 : 20 })
    expect(onLoad).toHaveBeenCalledTimes(2)
  })
})
