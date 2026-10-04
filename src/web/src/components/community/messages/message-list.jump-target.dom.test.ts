import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"
import { act, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames } from "@/test/message-scroll-fixture"

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({
  MessageRow: ({ m, highlighted }: { m: { id: string }; highlighted: boolean }) =>
    React.createElement("div", { "data-row-id": m.id, "data-highlighted": highlighted }),
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("./typing-indicator", () => ({ TypingIndicator: () => null }))
const target = { id: "m_target", type: "chat" as const, authorId: "user_2", authorName: "Alice", content: "Target", createdAt: new Date(0).toISOString() }
const unrelated = { ...target, id: "m_other", content: "Other" }
const newer = { ...target, id: "m_newer", content: "Newer", createdAt: new Date(1).toISOString() }
const consumed = vi.fn()
function view(messages: typeof target[], scrollToMessageId: string | null) {
  return React.createElement(MessageList, { channel: "general", messages, loading: false, initialScrollReady: false, hasMoreNewer: true, scrollToMessageId, onScrollTargetConsumed: consumed, onOpenThread: vi.fn() })
}
function highlighted(container: HTMLElement) {
  return container.querySelector('[data-row-id="m_target"]')?.getAttribute("data-highlighted") === "true"
}

describe("MessageList pending jump target with the installed native adapter", () => {
  beforeEach(() => { installMessageScrollFixture(); consumed.mockClear() })
  afterEach(restoreMessageScrollFixture)
  it("waits for the actual target body, consumes once, and resets after null", () => {
    const renderer = render(view([unrelated], "m_target"))
    resize()
    expect(consumed).not.toHaveBeenCalled()
    expect(renderer.container.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "false")
    renderer.rerender(view([unrelated, target], "m_target"))
    resize()
    expect(consumed).toHaveBeenCalledExactlyOnceWith("m_target")
    expect(highlighted(renderer.container)).toBe(true)
    expect(renderer.container.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    renderer.rerender(view([unrelated, target, newer], "m_target"))
    resize()
    expect(consumed).toHaveBeenCalledOnce()
    renderer.rerender(view([unrelated, target, newer], null))
    renderer.rerender(view([unrelated, target, newer], "m_target"))
    resize()
    expect(consumed).toHaveBeenCalledTimes(2)
    expect(highlighted(renderer.container)).toBe(true)
    act(() => vi.advanceTimersByTime(1600))
    runFrames()
    expect(highlighted(renderer.container)).toBe(false)
  })
  it("withholds cached message rows after definitive access denial", () => {
    const retry = vi.fn()
    const renderer = render(React.createElement(MessageList, { channel: "general", messages: [target], loading: false, onOpenThread: vi.fn(), initialLoadError: Object.assign(new Error("Forbidden"), { status: 403 }), onRetryInitialLoad: retry }))
    resize()
    expect(renderer.getByRole("alert")).toBeInTheDocument()
    expect(renderer.container.querySelector('[data-msg-id="m_target"]')).toBeNull()
    expect(renderer.queryByText(/Beginning of the channel/)).toBeNull()
    expect(renderer.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })
})
