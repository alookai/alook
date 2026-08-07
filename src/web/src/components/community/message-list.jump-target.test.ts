import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"

const mocks = vi.hoisted(() => {
  const scrollToIndex = vi.fn()
  const scrollToEnd = vi.fn()
  const onScrollTargetConsumed = vi.fn()
  return {
    scrollToIndex,
    scrollToEnd,
    onScrollTargetConsumed,
    virtualizer: {
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
    React.createElement("div", { "data-row-id": m.id, "data-highlighted": highlighted }),
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("./typing-indicator", () => ({ TypingIndicator: () => null }))

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

function render(
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

const visibleTargetNode = {
  dataset: { msgId: "m_target" },
  getBoundingClientRect: () => ({ top: 300, bottom: 400 }),
}

function createNodeMock(element: { props?: { className?: string } }) {
  if (element.props?.className?.includes("thin-scrollbar")) {
    return {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      offsetHeight: 48,
      clientHeight: 800,
      scrollTop: 0,
      querySelectorAll: () => [visibleTargetNode],
      getBoundingClientRect: () => ({ top: 0, bottom: 800 }),
    }
  }
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    offsetHeight: 48,
    clientHeight: 800,
    scrollTop: 0,
  }
}

function highlighted(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ "data-row-id": "m_target" }).props["data-highlighted"]
}

describe("MessageList pending jump target", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("window", {
      setTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      cancelAnimationFrame: vi.fn(),
    })
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    })
    mocks.scrollToIndex.mockClear()
    mocks.scrollToEnd.mockClear()
    mocks.onScrollTargetConsumed.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("waits for the target row, jumps once, and resets after null", () => {
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(render([unrelated], "m_target", false, false), { createNodeMock })
    })
    expect(mocks.scrollToEnd).not.toHaveBeenCalled()
    expect(mocks.scrollToIndex).not.toHaveBeenCalled()
    expect(mocks.onScrollTargetConsumed).not.toHaveBeenCalled()

    act(() => {
      renderer!.update(render([unrelated, target], "m_target", false, false))
    })
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce()
    expect(mocks.scrollToIndex).toHaveBeenCalledOnce()
    expect(mocks.scrollToEnd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scrollToIndex.mock.invocationCallOrder[0],
    )
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(2, { align: "center", behavior: "auto" })
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledOnce()
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledWith("m_target")
    expect(highlighted(renderer!)).toBe(true)

    act(() => {
      renderer!.update(render([unrelated, target, newer], "m_target", false, false))
    })
    expect(mocks.scrollToIndex).toHaveBeenCalledOnce()
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(800))

    act(() => {
      renderer!.update(render([unrelated, target, newer], null, false, false))
    })
    act(() => {
      renderer!.update(render([unrelated, target, newer], "m_target", false, false))
    })
    expect(mocks.scrollToIndex).toHaveBeenCalledTimes(2)
    expect(mocks.onScrollTargetConsumed).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(800))
    expect(highlighted(renderer!)).toBe(true)
    act(() => vi.advanceTimersByTime(799))
    expect(highlighted(renderer!)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(highlighted(renderer!)).toBe(false)
  })
})
