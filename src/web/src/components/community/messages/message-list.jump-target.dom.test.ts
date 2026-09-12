import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => {
  const scrollToIndex = vi.fn()
  const scrollToEnd = vi.fn()
  const onScrollTargetConsumed = vi.fn()
  return {
    scrollToIndex,
    scrollToEnd,
    onScrollTargetConsumed,
    virtualizer: {
      options: { anchorTo: "end" },
      scrollToIndex,
      scrollToEnd,
      isAtEnd: () => true,
      range: null,
    },
  }
})

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => mocks.virtualizer,
}))
vi.mock("@/hooks/community/use-virtual-cursor-sentinel", () => ({
  useVirtualCursorSentinel: () => vi.fn(),
}))
vi.mock("./virtual-cursor-list", () => ({
  VirtualRows: ({ items, renderItem }: {
    items: Array<{ key: string }>
    renderItem: (item: { key: string }) => React.ReactNode
  }) => React.createElement(React.Fragment, null, ...items.map((item) => renderItem(item))),
}))
vi.mock("./message-row", () => ({
  MessageRow: ({ m, highlighted }: { m: { id: string }; highlighted: boolean }) =>
    React.createElement("div", {
      "data-msg-id": m.id,
      "data-row-id": m.id,
      "data-highlighted": highlighted,
    }),
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("./typing-indicator", () => ({ TypingIndicator: () => null }))
vi.mock("./initial-position-aurora.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const target = {
  id: "m_target",
  type: "chat" as const,
  authorId: "user_2",
  authorName: "Alice",
  content: "Target",
  createdAt: new Date(0).toISOString(),
}

const unrelated = {
  ...target,
  id: "m_other",
  content: "Other",
}

const newer = {
  ...target,
  id: "m_newer",
  content: "Newer",
  createdAt: new Date(1).toISOString(),
}

function view(
  messages: typeof target[],
  scrollToMessageId: string | null,
  loading = false,
  initialScrollReady = true,
) {
  return React.createElement(MessageList, {
    channel: "general",
    messages,
    loading,
    initialScrollReady,
    hasMoreNewer: true,
    scrollToMessageId,
    onScrollTargetConsumed: mocks.onScrollTargetConsumed,
    onOpenThread: vi.fn(),
  })
}

function highlighted(container: HTMLElement) {
  return container.querySelector('[data-row-id="m_target"]')
    ?.getAttribute("data-highlighted") === "true"
}

describe("MessageList pending jump target", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    })
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800)
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      return (this as HTMLElement).dataset.msgId === "m_target"
        ? DOMRect.fromRect({ y: 300, height: 100 })
        : DOMRect.fromRect({ y: 0, height: 800 })
    })
    mocks.scrollToIndex.mockClear()
    mocks.scrollToEnd.mockClear()
    mocks.onScrollTargetConsumed.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("waits for the target row, jumps once, and resets after null", () => {
    const renderer = render(view([unrelated], "m_target", false, false))
    expect(mocks.scrollToEnd).not.toHaveBeenCalled()
    expect(mocks.scrollToIndex).not.toHaveBeenCalled()
    expect(mocks.onScrollTargetConsumed).not.toHaveBeenCalled()

    renderer.rerender(view([unrelated, target], "m_target", false, false))
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce()
    expect(mocks.scrollToIndex).toHaveBeenCalledOnce()
    expect(mocks.scrollToEnd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scrollToIndex.mock.invocationCallOrder[0],
    )
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(2, { align: "center", behavior: "auto" })
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledOnce()
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledWith("m_target")
    expect(highlighted(renderer.container)).toBe(true)

    renderer.rerender(view([unrelated, target, newer], "m_target", false, false))
    expect(mocks.scrollToIndex).toHaveBeenCalledOnce()
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(800))

    renderer.rerender(view([unrelated, target, newer], null, false, false))
    renderer.rerender(view([unrelated, target, newer], "m_target", false, false))
    expect(mocks.scrollToIndex).toHaveBeenCalledTimes(2)
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(800))
    expect(highlighted(renderer.container)).toBe(true)
    act(() => vi.advanceTimersByTime(799))
    expect(highlighted(renderer.container)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(highlighted(renderer.container)).toBe(false)
  })
})
