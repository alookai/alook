import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, screen } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import type { Breakpoint } from "@/hooks/use-mobile"
import { resolveThreadSplitMode, THREAD_SPLIT_MIN_CONTENT_WIDTH, useThreadSplitMode } from "./use-thread-split-mode"

function Harness({ forceFullscreen = false, breakpoint = "desktop", enabled = true, attach = true }: {
  forceFullscreen?: boolean
  breakpoint?: Breakpoint
  enabled?: boolean
  attach?: boolean
}) {
  const split = useThreadSplitMode({ breakpoint, enabled, forceFullscreen })
  return React.createElement("div", {
    ref: attach ? split.containerRef : undefined,
    "data-testid": "thread-split-mode",
    "data-mode": split.mode,
  })
}

describe("resolveThreadSplitMode", () => {
  it("uses split only when a desktop content pane can hold both conversations", () => {
    expect(resolveThreadSplitMode({ breakpoint: "desktop", contentWidth: THREAD_SPLIT_MIN_CONTENT_WIDTH, forceFullscreen: false })).toBe("split")
    expect(resolveThreadSplitMode({ breakpoint: "desktop", contentWidth: THREAD_SPLIT_MIN_CONTENT_WIDTH - 1, forceFullscreen: false })).toBe("full")
  })

  it("keeps mobile and explicit fullscreen layouts single-pane", () => {
    expect(resolveThreadSplitMode({ breakpoint: "mobile", contentWidth: 2000, forceFullscreen: false })).toBe("full")
    expect(resolveThreadSplitMode({ breakpoint: "desktop", contentWidth: 2000, forceFullscreen: true })).toBe("full")
  })

  it("keeps unconfirmed geometry pending instead of choosing a full layout", () => {
    expect(resolveThreadSplitMode({ breakpoint: "unknown", contentWidth: 2000, forceFullscreen: false })).toBe("pending")
    expect(resolveThreadSplitMode({ breakpoint: "desktop", contentWidth: null, forceFullscreen: false })).toBe("pending")
    expect(resolveThreadSplitMode({ breakpoint: "mobile", contentWidth: null, forceFullscreen: false })).toBe("full")
  })
})

describe("useThreadSplitMode shared geometry", () => {
  let observerCallback: ResizeObserverCallback | null
  let width: number
  const observe = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    observerCallback = null
    width = THREAD_SPLIT_MIN_CONTENT_WIDTH
    observe.mockClear()
    disconnect.mockClear()
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 0, top: 0, right: width, bottom: 0, left: 0, x: 0, y: 0, toJSON: () => ({}),
    }))
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { observerCallback = callback }
      observe = observe
      disconnect = disconnect
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("keeps a stable outer measurement node across target rerenders", () => {
    const renderer = render(React.createElement(Harness))
    const node = screen.getByTestId("thread-split-mode")
    expect(node).toHaveAttribute("data-mode", "split")
    expect(observe).toHaveBeenCalledWith(node)
    renderer.rerender(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toBe(node)
    expect(observe).toHaveBeenCalledOnce()
    renderer.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it("consumes the shared unknown-to-mobile transition without starting measurement", () => {
    const renderer = render(React.createElement(Harness, { breakpoint: "unknown" }))
    const node = screen.getByTestId("thread-split-mode")
    expect(node).toHaveAttribute("data-mode", "pending")
    expect(observe).not.toHaveBeenCalled()
    renderer.rerender(React.createElement(Harness, { breakpoint: "mobile" }))
    expect(screen.getByTestId("thread-split-mode")).toBe(node)
    expect(node).toHaveAttribute("data-mode", "full")
    expect(observe).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it.each([{ enabled: false }, { forceFullscreen: true }, { breakpoint: "mobile" as const }])(
    "starts no split preparation for %j", (props) => {
      const renderer = render(React.createElement(Harness, props))
      expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
      expect(observe).not.toHaveBeenCalled()
      renderer.unmount()
    },
  )

  it("waits for the real attached host and then measures it", () => {
    const renderer = render(React.createElement(Harness, { attach: false }))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "pending")
    expect(observe).not.toHaveBeenCalled()
    renderer.rerender(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "split")
    expect(observe).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("keeps desktop automatic measurement live below and above the split threshold", () => {
    const renderer = render(React.createElement(Harness))
    const node = screen.getByTestId("thread-split-mode")
    act(() => observerCallback?.([{ contentRect: { width: THREAD_SPLIT_MIN_CONTENT_WIDTH - 1 } } as unknown as ResizeObserverEntry], {} as ResizeObserver))
    expect(node).toHaveAttribute("data-mode", "full")
    expect(disconnect).not.toHaveBeenCalled()
    act(() => observerCallback?.([{ contentRect: { width: THREAD_SPLIT_MIN_CONTENT_WIDTH } } as unknown as ResizeObserverEntry], {} as ResizeObserver))
    expect(node).toHaveAttribute("data-mode", "split")
    expect(observe).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("stops full/mobile preparation and measures the current width on return", () => {
    const renderer = render(React.createElement(Harness))
    const node = screen.getByTestId("thread-split-mode")
    renderer.rerender(React.createElement(Harness, { forceFullscreen: true }))
    expect(node).toHaveAttribute("data-mode", "full")
    expect(disconnect).toHaveBeenCalledOnce()
    width -= 1
    renderer.rerender(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toBe(node)
    expect(node).toHaveAttribute("data-mode", "full")
    expect(observe).toHaveBeenCalledTimes(2)
    renderer.rerender(React.createElement(Harness, { breakpoint: "mobile" }))
    expect(disconnect).toHaveBeenCalledTimes(2)
    renderer.unmount()
  })

  it("falls back to window resize events when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const addEventListener = vi.spyOn(window, "addEventListener")
    const removeEventListener = vi.spyOn(window, "removeEventListener")
    const renderer = render(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "split")
    const resizeListener = addEventListener.mock.calls.find(([type]) => type === "resize")?.[1] as () => void
    expect(resizeListener).toEqual(expect.any(Function))
    width -= 1
    act(() => resizeListener())
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
    renderer.unmount()
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener)
  })
})
