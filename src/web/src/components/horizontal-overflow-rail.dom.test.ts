import { createElement, useCallback } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  fireEvent,
  mockElementGeometry,
  render,
  screen,
} from "@/test/react-dom-harness"
import {
  shouldTranslateVerticalWheel,
  useHorizontalOverflowRail,
} from "./horizontal-overflow-rail"

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

describe("useHorizontalOverflowRail", () => {
  function Fixture({ mapVerticalWheelToHorizontal = false, padding = 0, preserveChildKeyboard = false, selectedLeft = 120, initialOffset = 0 }: { mapVerticalWheelToHorizontal?: boolean; padding?: number; preserveChildKeyboard?: boolean; selectedLeft?: number; initialOffset?: number }) {
    const rail = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
      contentKey: "one\0two\0three",
      selectedKey: "three",
      mapVerticalWheelToHorizontal,
      preserveChildKeyboard,
    })
    const setScroller = useCallback((node: HTMLDivElement | null) => {
      rail.scrollerRef.current = node
      if (!node) return
      const restore = mockElementGeometry(node, {
        clientWidth: 100,
        left: 0,
        right: 100,
        scrollLeft: initialOffset,
        scrollWidth: 240,
      })
      return () => {
        restore()
        rail.scrollerRef.current = null
      }
    }, [initialOffset, rail.scrollerRef])
    const setSelected = useCallback((node: HTMLButtonElement | null) => {
      rail.selectedRef.current = node
      if (!node) return
      const restore = mockElementGeometry(node, { left: selectedLeft, right: selectedLeft + 44 })
      return () => {
        restore()
        rail.selectedRef.current = null
      }
    }, [rail.selectedRef, selectedLeft])
    return createElement("div", {
      ref: setScroller,
      "data-testid": "rail",
      style: { scrollPaddingLeft: padding, scrollPaddingRight: padding },
      tabIndex: 0,
      onKeyDown: rail.onKeyDown,
    }, createElement("button", { ref: setSelected }, "three"))
  }

  it("reveals the selected item and supports Arrow/Home/End scrolling", () => {
    render(createElement(Fixture))
    const rail = screen.getByTestId("rail")
    expect(rail.scrollLeft).toBe(64)

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

  it.each([
    { selectedLeft: 120, initialOffset: 0, expected: 80 },
    { selectedLeft: -20, initialOffset: 100, expected: 64 },
  ])("reveals selection at $selectedLeft inside the native scroll padding", ({ selectedLeft, initialOffset, expected }) => {
    render(createElement(Fixture, { padding: 16, selectedLeft, initialOffset }))
    expect(screen.getByTestId("rail").scrollLeft).toBe(expected)
  })

  it("preserves the tab child's native keyboard navigation", () => {
    render(createElement(Fixture, { preserveChildKeyboard: true }))
    const child = screen.getByRole("button", { name: "three" })
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "End" })
    fireEvent(child, event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.getByTestId("rail").scrollLeft).toBe(140)
  })

  it("keeps selection visible when the scroller or selected width changes and disconnects", () => {
    let notify: ResizeObserverCallback | undefined
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notify = callback }
      observe = observe
      disconnect = disconnect
    })
    const rendered = render(createElement(Fixture, { padding: 16 }))
    const rail = screen.getByTestId("rail")
    const selected = screen.getByRole("button", { name: "three" })
    const restoreRail = mockElementGeometry(rail, { right: 80, clientWidth: 80 })
    const restoreSelected = mockElementGeometry(selected, { left: 40, right: 84 })
    try {
      expect(observe).toHaveBeenCalledWith(rail)
      expect(observe).toHaveBeenCalledWith(selected)
      notify!([], {} as ResizeObserver)
      expect(rail.scrollLeft).toBe(100)
      rendered.unmount()
      expect(disconnect).toHaveBeenCalledOnce()
    } finally {
      restoreSelected()
      restoreRail()
      vi.unstubAllGlobals()
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
