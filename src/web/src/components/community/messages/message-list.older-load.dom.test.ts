import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render, type RenderResult } from "@/test/react-dom-harness"
import { MessageList } from "./message-list"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value),
}))

let scrollTopDescriptor: PropertyDescriptor | undefined
let scrollToDescriptor: PropertyDescriptor | undefined

function restorePrototypeProperty(name: "scrollTo" | "scrollTop", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
}

describe("MessageList — older-load sentinel does not cascade", () => {
  afterEach(() => {
    restorePrototypeProperty("scrollTop", scrollTopDescriptor)
    restorePrototypeProperty("scrollTo", scrollToDescriptor)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("fires onLoadOlder once per intersection, not on every fetch-state re-render", () => {
    let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null
    const scrollPositions = new WeakMap<HTMLElement, number>()
    scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() { return scrollPositions.get(this) ?? 500 },
      set(value: number) { scrollPositions.set(this, value) },
    })
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    })
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500)
    const removeEventListener = vi.spyOn(EventTarget.prototype, "removeEventListener")

    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        if (!ioCallback) ioCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    })

    const messages = [{
      id: "m1",
      authorName: "Alice",
      content: "hi",
      createdAt: new Date(0).toISOString(),
    }]
    const onLoadOlder = vi.fn()
    const view = (isFetchingOlder: boolean, hasMore = true) => React.createElement(MessageList, {
      channel: "general",
      messages,
      loading: false,
      hasMore,
      onLoadOlder,
      isFetchingOlder,
      onOpenThread: vi.fn(),
    })
    const intersect = () => act(() => ioCallback!([{ isIntersecting: true }]))
    let renderer: RenderResult = render(view(false))
    let scroller = renderer.getByTestId(tid.messageScroller)

    expect(ioCallback).not.toBeNull()

    intersect()
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    renderer.rerender(view(true))
    renderer.rerender(view(false))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    renderer.rerender(view(true))
    scroller.scrollTop = 250
    fireEvent.scroll(scroller)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    renderer.rerender(view(false))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    renderer.rerender(view(true))
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    scroller.scrollTop = 150
    fireEvent.scroll(scroller)
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    renderer.rerender(view(false))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    renderer.rerender(view(false))
    renderer.rerender(view(false))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    renderer.rerender(view(true))
    intersect()
    renderer.rerender(view(false, false))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    renderer.unmount()
    ioCallback = null
    renderer = render(view(true))
    scroller = renderer.getByTestId(tid.messageScroller)
    scroller.scrollTop = 500
    intersect()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    renderer.unmount()
    expect(removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })
})
