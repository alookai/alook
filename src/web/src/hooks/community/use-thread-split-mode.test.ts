import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  return React.createElement("div", { ref: split.containerRef, "data-mode": split.mode })
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

  beforeEach(() => {
    mocks.breakpoint = "desktop"
    mocks.claimSecondary.mockClear()
    mocks.releaseSecondary.mockClear()
    observerCallback = null
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { observerCallback = callback }
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("adds the parent only for split mode and clears it for fullscreen", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness), {
        createNodeMock: () => ({
          getBoundingClientRect: () => ({ width: THREAD_SPLIT_MIN_CONTENT_WIDTH }),
        }),
      })
    })
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("split")
    expect(mocks.claimSecondary).toHaveBeenCalledWith(expect.any(Symbol), "parent_1")

    act(() => renderer.update(React.createElement(Harness, { forceFullscreen: true })))
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("full")
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(expect.any(Symbol))

    act(() => renderer.unmount())
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(expect.any(Symbol))
    expect(observerCallback).not.toBeNull()
  })

  it("releases the parent before a pane hidden by resize or mobile fallback can stay focused", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness), {
        createNodeMock: () => ({
          getBoundingClientRect: () => ({ width: THREAD_SPLIT_MIN_CONTENT_WIDTH }),
        }),
      })
    })
    const owner = mocks.claimSecondary.mock.calls.at(-1)?.[0]

    act(() => {
      observerCallback?.([{
        contentRect: { width: THREAD_SPLIT_MIN_CONTENT_WIDTH - 1 },
      } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("full")
    expect(mocks.releaseSecondary).toHaveBeenCalledWith(owner)

    mocks.breakpoint = "mobile"
    act(() => renderer.update(React.createElement(Harness)))
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("full")
    expect(mocks.releaseSecondary).toHaveBeenLastCalledWith(owner)
  })

  it("falls back to window resize events when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal("window", { addEventListener, removeEventListener })
    let width = THREAD_SPLIT_MIN_CONTENT_WIDTH
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness), {
        createNodeMock: () => ({ getBoundingClientRect: () => ({ width }) }),
      })
    })
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("split")
    const resizeListener = addEventListener.mock.calls
      .find(([type]) => type === "resize")?.[1] as () => void
    expect(resizeListener).toEqual(expect.any(Function))

    width -= 1
    act(() => resizeListener())
    expect(renderer.root.findByType("div").props["data-mode"]).toBe("full")

    act(() => renderer.unmount())
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener)
  })
})
