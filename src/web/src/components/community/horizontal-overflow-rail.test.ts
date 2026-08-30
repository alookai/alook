import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  horizontalOverflowFades,
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

describe("useHorizontalOverflowRail", () => {
  const scroller = {
    scrollLeft: 0,
    scrollWidth: 240,
    clientWidth: 100,
    getBoundingClientRect: () => ({ left: 0, right: 100 }),
  }
  const selected = {
    getBoundingClientRect: () => ({ left: 120, right: 164 }),
  }

  function Fixture() {
    const rail = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
      contentKey: "one\0two\0three",
      selectedKey: "three",
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
})
