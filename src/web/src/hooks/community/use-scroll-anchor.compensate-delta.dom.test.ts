import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { useScrollAnchor } from "./use-scroll-anchor"
import type { FlatItem } from "@/lib/community/message-list-items"

const items: FlatItem[] = [
  { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
  { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
]

function Harness({ heroHeight }: { heroHeight: number }) {
  const { scrollRef } = useScrollAnchor({
    items,
    initialScrollReady: true,
    heroHeight,
  })
  return createElement("div", { ref: scrollRef, "data-testid": "scroll" })
}

describe("useScrollAnchor hero-swap compensation", () => {
  let scrollToDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_000)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, { top }: ScrollToOptions) {
        this.scrollTop = top ?? this.scrollTop
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (scrollToDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor)
    } else {
      delete HTMLElement.prototype.scrollTo
    }
  })

  it("shoves scrollTop down by the delta when the hero grows between renders", () => {
    const rendered = render(createElement(Harness, { heroHeight: 0 }))
    const scroll = screen.getByTestId("scroll")
    scroll.scrollTop = 200

    rendered.rerender(createElement(Harness, { heroHeight: 96 }))

    expect(scroll.scrollTop).toBe(296)
  })

  it("pulls scrollTop back up by the delta when the hero shrinks between renders", () => {
    const rendered = render(createElement(Harness, { heroHeight: 96 }))
    const scroll = screen.getByTestId("scroll")
    scroll.scrollTop = 300

    rendered.rerender(createElement(Harness, { heroHeight: 40 }))

    expect(scroll.scrollTop).toBe(244)
  })

  it("does not touch scrollTop when heroHeight is unchanged across a re-render", () => {
    const rendered = render(createElement(Harness, { heroHeight: 60 }))
    const scroll = screen.getByTestId("scroll")
    scroll.scrollTop = 150

    rendered.rerender(createElement(Harness, { heroHeight: 60 }))

    expect(scroll.scrollTop).toBe(150)
  })
})
