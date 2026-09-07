import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import {
  resolveThreadSplitMode,
  THREAD_SPLIT_MIN_CONTENT_WIDTH,
  useThreadSplitMode,
} from "./use-thread-split-mode"

const mocks = vi.hoisted(() => ({
  breakpoint: "desktop" as "desktop" | "mobile" | "unknown",
  claimSecondary: vi.fn(),
  releaseSecondary: vi.fn(),
}))

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsClaimSecondaryChannel: (...args: unknown[]) => mocks.claimSecondary(...args),
  communityWsReleaseSecondaryChannel: (...args: unknown[]) => mocks.releaseSecondary(...args),
}))

function Harness({ forceFullscreen = false }: { forceFullscreen?: boolean }) {
  const split = useThreadSplitMode({ parentChannelId: "parent_1", forceFullscreen })
  return React.createElement("div", {
    ref: split.containerRef,
    "data-testid": "thread-split-mode",
    "data-mode": split.mode,
  })
}

describe("resolveThreadSplitMode", () => {
  it("uses split only when a desktop content pane can hold both conversations", () => {
    expect(resolveThreadSplitMode({
      breakpoint: "desktop",
      contentWidth: THREAD_SPLIT_MIN_CONTENT_WIDTH,
      forceFullscreen: false,
    })).toBe("split")
    expect(resolveThreadSplitMode({
      breakpoint: "desktop",
      contentWidth: THREAD_SPLIT_MIN_CONTENT_WIDTH - 1,
      forceFullscreen: false,
    })).toBe("full")
  })

  it("keeps mobile, unresolved, and explicit fullscreen layouts single-pane", () => {
    for (const breakpoint of ["mobile", "unknown"] as const) {
      expect(resolveThreadSplitMode({ breakpoint, contentWidth: 2000, forceFullscreen: false })).toBe("full")
    }
    expect(resolveThreadSplitMode({
      breakpoint: "desktop",
      contentWidth: 2000,
      forceFullscreen: true,
    })).toBe("full")
  })
})

describe("useThreadSplitMode secondary live subscription", () => {
  let observerCallback: ResizeObserverCallback | null
  let width: number

  beforeEach(() => {
    mocks.breakpoint = "desktop"
    mocks.claimSecondary.mockClear()
    mocks.releaseSecondary.mockClear()
    observerCallback = null
    width = THREAD_SPLIT_MIN_CONTENT_WIDTH
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width,
      height: 0,
      top: 0,
      right: width,
      bottom: 0,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { observerCallback = callback }
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("adds the parent only for split mode and clears it for fullscreen", () => {
    const renderer = render(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "split")
    expect(mocks.claimSecondary).toHaveBeenCalledWith(expect.any(Symbol), "parent_1")

    renderer.rerender(React.createElement(Harness, { forceFullscreen: true }))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(expect.any(Symbol))

    renderer.unmount()
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(expect.any(Symbol))
    expect(observerCallback).not.toBeNull()
  })

  it("releases the parent before a pane hidden by resize or mobile fallback can stay focused", () => {
    const renderer = render(React.createElement(Harness))
    const owner = mocks.claimSecondary.mock.calls.at(-1)?.[0]

    act(() => {
      observerCallback?.([{
        contentRect: { width: THREAD_SPLIT_MIN_CONTENT_WIDTH - 1 },
      } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(owner)

    mocks.breakpoint = "mobile"
    renderer.rerender(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")
    expect(mocks.releaseSecondary).toHaveBeenLastCalledWith(owner)
  })

  it("falls back to window resize events when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const addEventListener = vi.spyOn(window, "addEventListener")
    const removeEventListener = vi.spyOn(window, "removeEventListener")
    const renderer = render(React.createElement(Harness))
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "split")
    const resizeListener = addEventListener.mock.calls
      .find(([type]) => type === "resize")?.[1] as () => void
    expect(resizeListener).toEqual(expect.any(Function))

    width -= 1
    act(() => resizeListener())
    expect(screen.getByTestId("thread-split-mode")).toHaveAttribute("data-mode", "full")

    renderer.unmount()
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener)
  })
})
