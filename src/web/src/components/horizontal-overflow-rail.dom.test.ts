import { createElement, useCallback } from "react"
import { describe, expect, it } from "vitest"
import {
  fireEvent,
  mockElementGeometry,
  render,
  screen,
} from "@/test/react-dom-harness"
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
    render(createElement(HorizontalOverflowFadeOverlays, {
      fades: { left: true, right: true },
      leftTestId: "left-fade",
      rightTestId: "right-fade",
      surface: "popover",
    }))

    expect(screen.getByTestId("left-fade")).toHaveClass("from-popover")
    expect(screen.getByTestId("right-fade")).toHaveClass("from-popover")
  })
})

describe("useHorizontalOverflowRail", () => {
  function Fixture({ mapVerticalWheelToHorizontal = false }: { mapVerticalWheelToHorizontal?: boolean }) {
    const rail = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
      contentKey: "one\0two\0three",
      selectedKey: "three",
      mapVerticalWheelToHorizontal,
    })
    const setScroller = useCallback((node: HTMLDivElement | null) => {
      rail.scrollerRef.current = node
      if (!node) return
      const restore = mockElementGeometry(node, {
        clientWidth: 100,
        left: 0,
        right: 100,
        scrollLeft: 0,
        scrollWidth: 240,
      })
      return () => {
        restore()
        rail.scrollerRef.current = null
      }
    }, [rail.scrollerRef])
    const setSelected = useCallback((node: HTMLButtonElement | null) => {
      rail.selectedRef.current = node
      if (!node) return
      const restore = mockElementGeometry(node, { left: 120, right: 164 })
      return () => {
        restore()
        rail.selectedRef.current = null
      }
    }, [rail.selectedRef])
    return createElement("div", {
      ref: setScroller,
      "data-testid": "rail",
      "data-fade-left": rail.fades.left,
      "data-fade-right": rail.fades.right,
      tabIndex: 0,
      onKeyDown: rail.onKeyDown,
      onScroll: rail.onScroll,
    }, createElement("button", { ref: setSelected }, "three"))
  }

  it("reveals the selected item and supports Arrow/Home/End scrolling", () => {
    render(createElement(Fixture))
    const rail = screen.getByTestId("rail")
    expect(rail.scrollLeft).toBe(64)
    expect(rail).toHaveAttribute("data-fade-left", "true")
    expect(rail).toHaveAttribute("data-fade-right", "true")

    for (const [key, expectedScrollLeft] of [
      ["Home", 0],
      ["ArrowRight", 48],
      ["End", 140],
    ] as const) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
      fireEvent(rail, event)
      expect(event.defaultPrevented).toBe(true)
      expect(rail.scrollLeft).toBe(expectedScrollLeft)
    }
  })

  it("maps an enabled vertical wheel and returns it to the page at the boundary", () => {
    const rendered = render(createElement(Fixture, { mapVerticalWheelToHorizontal: true }))
    const rail = screen.getByTestId("rail")

    const translated = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    })
    fireEvent(rail, translated)
    expect(rail.scrollLeft).toBe(104)
    expect(translated.defaultPrevented).toBe(true)

    rail.scrollLeft = 140
    const boundary = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    })
    fireEvent(rail, boundary)
    expect(rail.scrollLeft).toBe(140)
    expect(boundary.defaultPrevented).toBe(false)

    const horizontal = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 8,
      deltaY: -40,
    })
    fireEvent(rail, horizontal)
    expect(rail.scrollLeft).toBe(140)
    expect(horizontal.defaultPrevented).toBe(false)

    rendered.unmount()
    rail.scrollLeft = 0
    fireEvent(rail, new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    }))
    expect(rail.scrollLeft).toBe(0)
  })
})
