import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { MessageList } from "./message-list"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames } from "@/test/message-scroll-fixture"

const breakpoint = vi.hoisted(() => ({ value: "desktop" as "desktop" | "mobile" }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => breakpoint.value }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

describe("MessageList native range pagination", () => {
  it("loads and settles ordinary older pages after the position deadline while read remains closed", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, authorId: "alice", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }))
    const onLoadOlder = vi.fn()
    const view = (isFetchingOlder: boolean) => React.createElement(MessageList, { channel: "general", messages, initialScrollReady: false, hasMore: true, onLoadOlder, isFetchingOlder, onOpenThread: vi.fn() })
    const renderer = render(view(false))
    resize()
    const scroller = renderer.getByTestId(tid.messageScroller)
    act(() => { scroller.scrollTo({ top: 0 }) })
    runFrames()
    expect(onLoadOlder).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2000))
    runFrames()
    act(() => { scroller.scrollTo({ top: 0 }) })
    resize()
    expect(renderer.container.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(onLoadOlder).toHaveBeenCalledOnce()
    renderer.rerender(view(true))
    resize()
    renderer.rerender(view(false))
    resize()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    expect(renderer.container.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
  })

  it.each([
    ["header", "alice", false], ["first", "alice", false], ["inside", "alice", false],
    ["header", "bob", false], ["first", "bob", false], ["inside", "bob", false],
    ["first", "alice", true], ["inside", "alice", true], ["return", "bob", true],
  ] as const)("retains the first-window body at the %s fold with older author %s and pending move %s", (fold, olderAuthor, pendingMove) => {
    const message = (i: number) => ({ id: `m${i}`, type: "chat" as const, authorId: "alice", authorName: "Alice", content: "hi", createdAt: new Date(i * 1000).toISOString() })
    let messages = Array.from({ length: 50 }, (_, i) => message(i + 40))
    const onLoadOlder = vi.fn()
    const view = (isFetchingOlder: boolean, hasMore = true) => React.createElement(MessageList, { channel: "general", messages, initialScrollReady: false, hasMore, onLoadOlder, isFetchingOlder, onOpenThread: vi.fn() })
    const renderer = render(view(false, fold === "header" || pendingMove))
    resize()
    act(() => vi.advanceTimersByTime(2000))
    runFrames()
    const root = renderer.getByTestId(tid.messageScroller)
    act(() => root.scrollTo({ top: 0 }))
    resize()
    const body = renderer.getByTestId(tid.message("m40"))
    const row = body.closest<HTMLElement>("[data-message-row-key]")!
    expect(row.style.paddingBlock).toBe("8px 4px")
    const moveToFold = () => {
      const start = root.scrollTop + row.getBoundingClientRect().top - root.getBoundingClientRect().top
      act(() => root.scrollTo({ top: start + (fold === "inside" ? 30 : 0) }))
      resize()
      if (fold === "return") {
        act(() => root.scrollTo({ top: 0 }))
        resize()
      }
    }
    if (!pendingMove && fold !== "header") {
      expect(onLoadOlder).not.toHaveBeenCalled()
      moveToFold()
      renderer.rerender(view(false))
      resize()
    }
    expect(onLoadOlder).toHaveBeenCalledOnce()
    renderer.rerender(view(true))
    resize()
    if (pendingMove) moveToFold()
    const before = body.getBoundingClientRect().top - root.getBoundingClientRect().top
    messages = [...Array.from({ length: 39 }, (_, i) => ({ ...message(i + 1), authorId: olderAuthor })), ...messages]
    renderer.rerender(view(false))
    resize()
    const after = renderer.getByTestId(tid.message("m40"))
    expect(after.closest<HTMLElement>("[data-message-row-key]")!.style.paddingBlock).toBe(olderAuthor === "alice" ? "4px 4px" : "8px 4px")
    const offset = after.getBoundingClientRect().top - root.getBoundingClientRect().top
    expect(Math.abs(offset - before)).toBeLessThanOrEqual(1)
    expect(renderer.container.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
  })
  beforeEach(() => { breakpoint.value = "desktop"; installMessageScrollFixture() })
  afterEach(restoreMessageScrollFixture)
  it.each([["mobile", 40], ["desktop", 48]] as const)("keeps %s body-to-viewport clearance at %ipx with symmetric row padding", (stage, gap) => {
    breakpoint.value = stage
    const messages = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }))
    const renderer = render(React.createElement(MessageList, { channel: "general", messages, loading: false, hasMore: false, onOpenThread: vi.fn() }))
    resize()
    runFrames()
    const scroller = renderer.getByTestId(tid.messageScroller)
    act(() => { scroller.scrollTo({ top: scroller.scrollHeight }) })
    resize()
    const tail = renderer.getByTestId(tid.message("m13"))
    const wrapper = tail.closest<HTMLElement>("[data-index]")!
    expect(tail.getBoundingClientRect().top - wrapper.getBoundingClientRect().top).toBe(8)
    expect(wrapper.getBoundingClientRect().bottom - tail.getBoundingClientRect().bottom).toBe(8)
    expect(scroller.getBoundingClientRect().bottom - tail.getBoundingClientRect().bottom).toBe(gap)
  })
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
