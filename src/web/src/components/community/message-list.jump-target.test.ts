import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"

const mocks = vi.hoisted(() => ({ jumpToIndex: vi.fn() }))

vi.mock("@/hooks/community/use-scroll-anchor", () => ({
  useScrollAnchor: () => ({
    scrollRef: { current: null },
    virtualizer: {},
    belowCount: 0,
    scrollToBottom: vi.fn(),
    jumpTo: mocks.jumpToIndex,
    onImageLoad: vi.fn(),
  }),
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

function render(messages: typeof target[], scrollToMessageId: string | null, loading = false) {
  return React.createElement(MessageList, {
    channel: "general",
    messages,
    loading,
    scrollToMessageId,
    onOpenThread: vi.fn(),
  })
}

function highlighted(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ "data-row-id": "m_target" }).props["data-highlighted"]
}

describe("MessageList pending jump target", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("window", { setTimeout })
    mocks.jumpToIndex.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("waits for the target row, jumps once, and resets after null", () => {
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(render([], "m_target", true))
    })
    expect(mocks.jumpToIndex).not.toHaveBeenCalled()

    act(() => {
      renderer!.update(render([target], "m_target"))
    })
    expect(mocks.jumpToIndex).toHaveBeenCalledOnce()
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("m_target")
    expect(highlighted(renderer!)).toBe(true)

    act(() => {
      renderer!.update(render([target, unrelated], "m_target"))
    })
    expect(mocks.jumpToIndex).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(1599))
    expect(highlighted(renderer!)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(highlighted(renderer!)).toBe(false)

    act(() => {
      renderer!.update(render([target, unrelated], null))
    })
    act(() => {
      renderer!.update(render([target, unrelated], "m_target"))
    })
    expect(mocks.jumpToIndex).toHaveBeenCalledTimes(2)
    expect(highlighted(renderer!)).toBe(true)
  })
})
