import { createElement, useLayoutEffect, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { useVirtualCursorSentinel } from "./use-virtual-cursor-sentinel"

type Props = {
  edge: "start" | "end"
  hasMore: boolean
  isFetching: boolean
  onLoad: () => void
}

let intersectionCallback: IntersectionObserverCallback
let disconnect: ReturnType<typeof vi.fn>
let observed: Element | undefined

function Harness(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useVirtualCursorSentinel({ scrollRef, ...props })
  useLayoutEffect(() => {
    scrollRef.current = document.querySelector('[data-testid="scroll"]')
    sentinelRef.current = document.querySelector('[data-testid="sentinel"]')
    return () => {
      scrollRef.current = null
      sentinelRef.current = null
    }
  }, [sentinelRef])
  return createElement(
    "div",
    { "data-testid": "scroll" },
    createElement("div", { "data-testid": "sentinel" }),
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

  afterEach(() => vi.unstubAllGlobals())

  it("loads on a true intersection and ignores false entries", () => {
    const onLoad = vi.fn()
    renderView({ edge, hasMore: true, isFetching: false, onLoad })

    intersect(false)
    expect(onLoad).not.toHaveBeenCalled()
    intersect(true)
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it("replays one busy demand once after settle without cascading", () => {
    const onLoad = vi.fn()
    const view = renderView({ edge, hasMore: true, isFetching: true, onLoad })
    intersect(true)
    intersect(true)
    expect(onLoad).not.toHaveBeenCalled()

    view.rerender({ edge, hasMore: true, isFetching: false, onLoad })
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender({ edge, hasMore: true, isFetching: false, onLoad })
    expect(onLoad).toHaveBeenCalledOnce()
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
})
