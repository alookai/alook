import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { MessageList } from "./message-list"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames } from "@/test/message-scroll-fixture"

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

describe("MessageList virtual older sentinel does not cascade", () => {
  beforeEach(installMessageScrollFixture)
  afterEach(restoreMessageScrollFixture)
  it("loads once per intersection, retains its fetch lock, and accepts fresh edge input", () => {
    let callback: IntersectionObserverCallback
    let element: Element
    const disconnected = vi.fn()
    vi.stubGlobal("IntersectionObserver", class {
      constructor(next: IntersectionObserverCallback) { callback = next }
      observe(target: Element) { element = target }
      disconnect() { disconnected() }
    })
    const messages = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }))
    const onLoadOlder = vi.fn()
    const view = (isFetchingOlder: boolean, hasMore = true) => React.createElement(MessageList, { channel: "general", messages, loading: false, hasMore, onLoadOlder, isFetchingOlder, onOpenThread: vi.fn() })
    const intersect = (isIntersecting = true) => act(() => callback([{ isIntersecting, target: element } as IntersectionObserverEntry], {} as IntersectionObserver))
    const renderer = render(view(false))
    resize()
    const scroller = renderer.getByTestId(tid.messageScroller)
    fireEvent.wheel(scroller, { deltaY: -20 })
    act(() => { scroller.scrollTo({ top: 0 }) })
    runFrames()
    resize()
    expect(element!.isConnected).toBe(true)
    intersect()
    expect(onLoadOlder).toHaveBeenCalledOnce()
    renderer.rerender(view(true))
    renderer.rerender(view(false))
    resize()
    expect(onLoadOlder).toHaveBeenCalledOnce()
    act(() => { scroller.scrollTo({ top: 0 }) })
    fireEvent.wheel(scroller, { deltaY: -20 })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    renderer.rerender(view(false))
    intersect(false)
    intersect(true)
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    renderer.rerender(view(true))
    renderer.rerender(view(false, false))
    resize()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    renderer.unmount()
    expect(disconnected).toHaveBeenCalled()
  })
})
