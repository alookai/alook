import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { MessageList } from "./message-list"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames } from "@/test/message-scroll-fixture"

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

describe("MessageList native range pagination", () => {
  beforeEach(installMessageScrollFixture)
  afterEach(restoreMessageScrollFixture)
  it("stops automatic pagination on the existing Query error surface", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }))
    const onLoadOlder = vi.fn()
    const makeView = (error: Error | null) => React.createElement(MessageList, { channel: "general", messages, loading: false, hasMore: true, onLoadOlder, initialLoadError: error, onOpenThread: vi.fn() })
    const renderer = render(makeView(new Error("page failed after retries")))
    resize()
    runFrames()
    const scroller = renderer.getByTestId(tid.messageScroller)
    fireEvent.wheel(scroller, { deltaY: -400 })
    act(() => { scroller.scrollTo({ top: 0 }) })
    runFrames()
    resize()
    expect(onLoadOlder).not.toHaveBeenCalled()
    renderer.rerender(makeView(null))
    runFrames()
    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it("continues loading at the top after fetch settlement without a fresh gesture", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }))
    const onLoadOlder = vi.fn()
    const view = (isFetchingOlder: boolean, hasMore = true) => React.createElement(MessageList, { channel: "general", messages, loading: false, hasMore, onLoadOlder, isFetchingOlder, onOpenThread: vi.fn() })
    const renderer = render(view(false))
    resize()
    runFrames()
    const scroller = renderer.getByTestId(tid.messageScroller)
    expect(onLoadOlder).not.toHaveBeenCalled()

    fireEvent.wheel(scroller, { deltaY: -400 })
    act(() => { scroller.scrollTo({ top: 0 }) })
    runFrames()
    resize()
    expect(onLoadOlder).toHaveBeenCalledOnce()

    renderer.rerender(view(true))
    fireEvent.wheel(scroller, { deltaY: -400 })
    act(() => { scroller.scrollTo({ top: 0 }) })
    runFrames()
    expect(onLoadOlder).toHaveBeenCalledOnce()

    renderer.rerender(view(false))
    runFrames()
    resize()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    renderer.rerender(view(true))
    renderer.rerender(view(false, false))
    runFrames()
    resize()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    renderer.unmount()
  })
})
