import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import React from "react"
import { MessageList } from "./message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "./conversation-footer-shell"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken } from "@/lib/community/conversation-qualification"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { tid } from "@/lib/community/testids"
import type { MessageRequestResult } from "@/lib/community/message-position"

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

describe("MessageList loading-to-loaded mount identity", () => {
  beforeEach(installMessageScrollFixture)
  afterEach(restoreMessageScrollFixture)
  it.each([false, true])("finishes a foreground tail beyond one-screen paging through the existing present request, already pending=%s", async pending => {
    const entry = {}, before = {}, received = {}
    const rows = Array.from({ length: 14 }, (_, index) => ({ id: `m${index}`, authorId: "peer", authorName: "Alice",
      content: "Message", createdAt: new Date(index * 1000).toISOString() }))
    let finish!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>(resolve => { finish = resolve })
    const request = { accepted: true, completed }
    let sourceCommitted = false
    const present = vi.fn(() => sourceCommitted ? request : { accepted: false })
    const page = vi.fn(() => ({ accepted: false }))
    function Source({ active, hasMoreNewer, messages, messageWindow, presentPending }: {
      active: boolean; hasMoreNewer: boolean; messages: typeof rows; messageWindow: object; presentPending: boolean
    }) {
      React.useLayoutEffect(() => {
        sourceCommitted = active
        return () => { sourceCommitted = false }
      }, [active])
      return React.createElement(MessageList, {
        channel: "general", messages, onOpenThread: vi.fn(), positionEntry: entry, messageWindow, active,
        hasMore: false, hasMoreNewer, onLoadNewer: page, onJumpToPresent: present, positionDataState: "ready",
        presentPending, presentRequest: presentPending ? request : null, isFetchingNewer: presentPending,
      })
    }
    const scene = (active: boolean, hasMoreNewer: boolean, messages = rows, messageWindow = before, presentPending = false) =>
      React.createElement(Source, { active, hasMoreNewer, messages, messageWindow, presentPending })
    const view = render(scene(true, false))
    resize()
    const root = view.getByTestId(tid.messageScroller)
    view.rerender(scene(false, false))
    resize()
    const partial = [...rows, ...Array.from({ length: 60 }, (_, index) => ({ ...rows[0], id: `partial${index}` }))]
    view.rerender(scene(false, true, partial, before, pending))
    resize()
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(root.clientHeight)
    view.rerender(scene(true, true, partial, before, pending))
    resize()
    expect(present).toHaveBeenCalledTimes(pending ? 0 : 1)
    expect(page).not.toHaveBeenCalled()
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "false")
    await act(async () => { finish({ status: "success", window: received }); await completed })
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "false")
    const tail = [{ ...rows[0], id: "qualified-present-tail" }]
    view.rerender(scene(true, false, tail, received))
    resize()
    expect(view.getByTestId(tid.messageScroller)).toBe(root)
    expect(present).toHaveBeenCalledTimes(pending ? 0 : 1)
    expect(page).not.toHaveBeenCalled()
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    expect(Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  })

  it("keeps the existing newer paginator live while a pinned foreground resume waits for its tail", async () => {
    const entry = {}, before = {}, received = {}
    const rows = Array.from({ length: 14 }, (_, index) => ({ id: `m${index}`, authorId: "peer", authorName: "Alice",
      content: "Message", createdAt: new Date(index * 1000).toISOString() }))
    let finish!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>(resolve => { finish = resolve })
    const load = vi.fn(() => ({ accepted: true, completed }))
    const scene = (active: boolean, hasMoreNewer: boolean, messages = rows, messageWindow = before) => React.createElement(MessageList, {
      channel: "general", messages, onOpenThread: vi.fn(), positionEntry: entry, messageWindow,
      active, hasMore: false, hasMoreNewer, onLoadNewer: load, positionDataState: "ready",
    })
    const view = render(scene(true, false))
    resize()
    const root = view.getByTestId(tid.messageScroller)
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    view.rerender(scene(false, false))
    resize()
    const appended = [...rows, { ...rows[0], id: "hidden-append" }]
    view.rerender(scene(false, true, appended))
    resize()
    expect(load).not.toHaveBeenCalled()
    view.rerender(scene(true, true, appended))
    resize()
    expect(load).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "false")
    await act(async () => { finish({ status: "success", window: received }) })
    const current = [...appended, { ...rows[0], id: "newer-page-tail" }]
    view.rerender(scene(true, false, current, received))
    resize()
    expect(view.getByTestId(tid.messageScroller)).toBe(root)
    expect(load).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
    expect(Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  })

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
    const rows = root.querySelector<HTMLElement>('[data-message-list-content] > div')!
    expect(Number.parseFloat(rows.style.height)).toBeLessThan(root.clientHeight)
    expect(rows.getBoundingClientRect().bottom).toBe(root.getBoundingClientRect().bottom)
    expect(root.querySelector<HTMLElement>('[data-msg-id="m1"]')!.getBoundingClientRect().bottom).toBe(root.clientHeight - 40)
    expect(root.querySelector('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  })

  it("uses ordinary entry after loading and then retains the mounted list", async () => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "A"), tag: null }
    const messages = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, type: "chat" as const,
      authorId: "peer", authorName: "Alice", content: "Message", createdAt: new Date(index * 1000).toISOString() }))
    const props = { channel: "A", onOpenThread: () => {}, positionScope }
    const first = render(React.createElement(MessageList, { ...props, messages }))
    resize()
    const root = first.getByTestId(tid.messageScroller)
    fireEvent.wheel(root, { deltaY: -30 })
    act(() => root.scrollTo({ top: 800 }))
    runFrames()
    resize()
    const before = root.scrollTop
    first.unmount()
    const second = render(React.createElement(MessageList, { ...props, messages: [], loading: true, initialScrollReady: false }))
    resize()
    second.rerender(React.createElement(MessageList, { ...props, messages, initialScrollReady: true, initialPositionMessageId: "m25" }))
    resize()
    const restored = second.getByTestId(tid.messageScroller)
    expect(restored.scrollTop).not.toBe(before)
    const entered = restored.scrollTop
    expect(restored.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    second.rerender(React.createElement(MessageList, { ...props, positionScope: { ...positionScope, proof: captureChannelMetadataToken(client, "A") }, messages, initialScrollReady: true, initialPositionMessageId: "m25", isFetching: true }))
    resize()
    expect(second.getByTestId(tid.messageScroller)).toBe(restored)
    expect(restored.scrollTop).toBeCloseTo(entered, 0)
  })
})
