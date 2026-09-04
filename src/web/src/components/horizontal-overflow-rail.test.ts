import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  HorizontalOverflowFadeOverlays,
  horizontalOverflowFades,
  shouldTranslateVerticalWheel,
  useHorizontalOverflowRail,
} from "./horizontal-overflow-rail"

describe("horizontalOverflowFades", () => {
  it("only enables fades for directions that still scroll", () => {
    expect(horizontalOverflowFades({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 }))
      .toEqual({ left: false, right: false })
    expect(horizontalOverflowFades({ scrollLeft: 0, scrollWidth: 240, clientWidth: 100 }))
      .toEqual({ left: false, right: true })
    expect(horizontalOverflowFades({ scrollLeft: 60, scrollWidth: 240, clientWidth: 100 }))
      .toEqual({ left: true, right: true })
    expect(horizontalOverflowFades({ scrollLeft: 140, scrollWidth: 240, clientWidth: 100 }))
      .toEqual({ left: true, right: false })
  })
})

describe("shouldTranslateVerticalWheel", () => {
  const overflowing = {
    enabled: true,
    deltaX: 0,
    deltaY: 40,
    ctrlKey: false,
    shiftKey: false,
    scrollLeft: 0,
    scrollWidth: 240,
    clientWidth: 100,
  }

  it("only consumes a vertical wheel when content remains in that direction", () => {
    expect(shouldTranslateVerticalWheel(overflowing)).toBe(true)
    expect(shouldTranslateVerticalWheel({ ...overflowing, deltaY: -40 })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, scrollLeft: 60, deltaY: -40 })).toBe(true)
    expect(shouldTranslateVerticalWheel({ ...overflowing, scrollLeft: 140 })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, scrollWidth: 100 })).toBe(false)
  })

  it("preserves disabled, horizontal, shifted, and zoom gestures", () => {
    expect(shouldTranslateVerticalWheel({ ...overflowing, enabled: false })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, deltaX: 1 })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, shiftKey: true })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, ctrlKey: true })).toBe(false)
    expect(shouldTranslateVerticalWheel({ ...overflowing, deltaY: 0 })).toBe(false)
  })
})

describe("HorizontalOverflowFadeOverlays", () => {
  it("matches the caller's surface token", () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(HorizontalOverflowFadeOverlays, {
        fades: { left: true, right: true },
        leftTestId: "left-fade",
        rightTestId: "right-fade",
        surface: "popover",
      }))
    })

    expect(renderer!.root.findByProps({ "data-testid": "left-fade" }).props.className)
      .toContain("from-popover")
    expect(renderer!.root.findByProps({ "data-testid": "right-fade" }).props.className)
      .toContain("from-popover")
  })
})

describe("useHorizontalOverflowRail", () => {
  let wheelListener: ((event: WheelEvent) => void) | undefined
  const scroller = {
    scrollLeft: 0,
    scrollWidth: 240,
    clientWidth: 100,
    getBoundingClientRect: () => ({ left: 0, right: 100 }),
    addEventListener: vi.fn((eventName: string, listener: EventListener) => {
      if (eventName === "wheel") wheelListener = listener as (event: WheelEvent) => void
    }),
    removeEventListener: vi.fn(),
  }
  const selected = {
    getBoundingClientRect: () => ({ left: 120, right: 164 }),
  }

  function Fixture({ mapVerticalWheelToHorizontal = false }: { mapVerticalWheelToHorizontal?: boolean }) {
    const rail = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
      contentKey: "one\0two\0three",
      selectedKey: "three",
      mapVerticalWheelToHorizontal,
    })
    return createElement("div", {
      ref: rail.scrollerRef,
      "data-testid": "rail",
      "data-fade-left": rail.fades.left,
      "data-fade-right": rail.fades.right,
      onKeyDown: rail.onKeyDown,
      onScroll: rail.onScroll,
    }, createElement("button", { ref: rail.selectedRef }, "three"))
  }

  it("reveals the selected item and supports Arrow/Home/End scrolling", () => {
    scroller.scrollLeft = 0
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(Fixture), {
        createNodeMock: (element) => element.props["data-testid"] === "rail" ? scroller : selected,
      })
    })
    expect(scroller.scrollLeft).toBe(64)
    const rail = renderer!.root.findByProps({ "data-testid": "rail" })
    expect(rail.props["data-fade-left"]).toBe(true)
    expect(rail.props["data-fade-right"]).toBe(true)

    const preventDefault = vi.fn()
    act(() => rail.props.onKeyDown({ key: "Home", currentTarget: scroller, preventDefault }))
    expect(scroller.scrollLeft).toBe(0)
    act(() => rail.props.onKeyDown({ key: "ArrowRight", currentTarget: scroller, preventDefault }))
    expect(scroller.scrollLeft).toBe(48)
    act(() => rail.props.onKeyDown({ key: "End", currentTarget: scroller, preventDefault }))
    expect(scroller.scrollLeft).toBe(140)
    expect(preventDefault).toHaveBeenCalledTimes(3)
  })

  it("maps an enabled vertical wheel and returns it to the page at the boundary", () => {
    scroller.scrollLeft = 0
    wheelListener = undefined
    scroller.addEventListener.mockClear()
    scroller.removeEventListener.mockClear()
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(Fixture, { mapVerticalWheelToHorizontal: true }), {
        createNodeMock: (element) => element.props["data-testid"] === "rail" ? scroller : selected,
      })
    })
    const preventDefault = vi.fn()
    expect(scroller.addEventListener).toHaveBeenCalledWith(
      "wheel",
      expect.any(Function),
      { passive: false },
    )

    act(() => wheelListener?.({
      deltaX: 0,
      deltaY: 40,
      ctrlKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as WheelEvent))
    expect(scroller.scrollLeft).toBe(104)
    expect(preventDefault).toHaveBeenCalledOnce()

    scroller.scrollLeft = 140
    act(() => wheelListener?.({
      deltaX: 0,
      deltaY: 40,
      ctrlKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as WheelEvent))
    expect(scroller.scrollLeft).toBe(140)
    expect(preventDefault).toHaveBeenCalledOnce()

    act(() => wheelListener?.({
      deltaX: 8,
      deltaY: -40,
      ctrlKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as WheelEvent))
    expect(scroller.scrollLeft).toBe(140)
    expect(preventDefault).toHaveBeenCalledOnce()

    act(() => renderer!.unmount())
    expect(scroller.removeEventListener).toHaveBeenCalledWith("wheel", wheelListener)
  })
})
