import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import React from "react"
import { MessageList } from "./message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "./conversation-footer-shell"
import { render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, scrollFixture } from "@/test/message-scroll-fixture"
import { tid } from "@/lib/community/testids"

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

describe("MessageList loading-to-loaded mount identity", () => {
  beforeEach(installMessageScrollFixture)
  afterEach(restoreMessageScrollFixture)
  it("keeps the scroller and settles the first real row once across the prop transition", () => {
    const messages = [{ id: "m1", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }]
    const view = (loading: boolean) => React.createElement(MessageList, { channel: "general", messages: loading ? [] : messages, loading, newDividerBefore: "m1", onOpenThread: vi.fn() })
    const renderer = render(view(true))
    resize()
    const root = renderer.getByTestId(tid.messageScroller)
    renderer.rerender(view(false))
    resize()
    expect(renderer.getByTestId(tid.messageScroller)).toBe(root)
    expect(renderer.container.querySelector('[data-msg-id="m1"]')).toBeInTheDocument()
    expect(renderer.container.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    expect(renderer.container.querySelector('[data-message-list-content]')).toHaveAttribute("aria-hidden", "false")
    const calls = scrollFixture.scrollCalls.length
    renderer.rerender(view(false))
    resize()
    expect(renderer.getByTestId(tid.messageScroller)).toBe(root)
    expect(scrollFixture.scrollCalls).toHaveLength(calls)
  })
  it("keeps true-empty typing clearance and removes that spacer when the first native row arrives", () => {
    const messages = [{ id: "m1", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }]
    const view = (empty: boolean) => React.createElement(ConversationFooterSlotProvider, null,
      React.createElement(MessageList, { channel: "general", messages: empty ? [] : messages, loading: false, typingUsers: ["Alice"], onOpenThread: vi.fn() }),
      React.createElement(ConversationFooterShell, null, React.createElement("div", { "data-testid": "composer" })),
    )
    const renderer = render(view(true))
    resize()
    expect(renderer.container.querySelector('[data-msg-id]')).toBeNull()
    expect(renderer.container.querySelector('[data-message-empty-tail]')).toHaveStyle({ height: "40px" })
    expect(renderer.getByTestId(tid.composerAccessoryRail)).toBeInTheDocument()
    expect(renderer.getByTestId(tid.typingIndicator)).toHaveTextContent("Alice is typing")
    const root = renderer.getByTestId(tid.messageScroller)
    const typing = renderer.getByTestId(tid.typingIndicator)
    const footer = renderer.container.querySelector('[data-slot="community-conversation-footer"]')!
    expect(footer.contains(typing)).toBe(true)
    expect(root.contains(typing)).toBe(false)
    renderer.rerender(view(false))
    resize()
    expect(renderer.getByTestId(tid.messageScroller)).toBe(root)
    expect(footer.contains(renderer.getByTestId(tid.typingIndicator))).toBe(true)
    expect(renderer.container.querySelector('[data-message-empty-tail]')).toBeNull()
    expect(renderer.container.querySelectorAll('[data-index]')).toHaveLength(3)
    expect(renderer.container.querySelectorAll('[data-msg-id]')).toHaveLength(1)
    expect(root.querySelector<HTMLElement>('[data-message-list-content] > div')?.style.height).toBe("500px")
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  })
})
