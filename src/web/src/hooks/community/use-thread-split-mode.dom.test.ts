import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, screen } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import type { Breakpoint } from "@/hooks/use-mobile"
import { useThreadSplitMode } from "./use-thread-split-mode"

function Harness({ forceFullscreen = false, breakpoint = "desktop", enabled = true, attach = true }: {
  forceFullscreen?: boolean
  breakpoint?: Breakpoint
  enabled?: boolean
  attach?: boolean
}) {
  const split = useThreadSplitMode({ breakpoint, enabled, forceFullscreen })
  return React.createElement("div", {
    "data-testid": "thread-split-mode",
    "data-mode": split.mode,
  }, React.createElement("span", { ref: attach ? split.modeMarkerRef : undefined, "data-testid": "thread-split-marker" }))
}

describe("useThreadSplitMode shared geometry", () => {
  let observerCallback: ResizeObserverCallback | null
  let cssMode: string
  const observe = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    observerCallback = null
    cssMode = "split"
    observe.mockClear()
    disconnect.mockClear()
    const getComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => element.getAttribute("data-testid") === "thread-split-marker"
      ? { getPropertyValue: (name: string) => name === "--thread-split-mode" ? cssMode : "" } as CSSStyleDeclaration
      : getComputedStyle(element))
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

  it.each(["", "unknown"])("keeps an unconfirmed CSS mode pending: %j", (value) => {
    cssMode = value
    const renderer = render(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "pending")
    renderer.unmount()
  })

  it("keeps a stable owned marker and observes its parent across target rerenders", () => {
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

  it("reads the current CSS decision on each parent resize", () => {
    const renderer = render(React.createElement(Harness))
    const node = screen.getByTestId("thread-split-mode")
    cssMode = "full"
    act(() => observerCallback?.([], {} as ResizeObserver))
    expect(node).toHaveAttribute("data-mode", "full")
    expect(disconnect).not.toHaveBeenCalled()
    cssMode = "split"
    act(() => observerCallback?.([], {} as ResizeObserver))
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
    cssMode = "full"
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
    cssMode = "full"
    act(() => resizeListener())
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
    renderer.unmount()
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener)
  })
})
