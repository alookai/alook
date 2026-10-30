import React from "react"
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageRequestResult } from "@/lib/community/message-position"
import { tid } from "@/lib/community/testids"
import { MessageList } from "./message-list"

const anchorState = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("@/hooks/community/use-scroll-anchor").useScrollAnchor> | null,
  nativeWrites: [] as Array<{ offset: number; adjustments: number; behavior?: ScrollBehavior }>,
}))

vi.mock("@/hooks/community/use-scroll-anchor", async importOriginal => {
  const original = await importOriginal<typeof import("@/hooks/community/use-scroll-anchor")>()
  return { ...original, useScrollAnchor: (input: Parameters<typeof original.useScrollAnchor>[0]) => {
    const anchor = original.useScrollAnchor(input)
    anchorState.current = anchor
    const scroll = anchor.virtualizer.options.scrollToFn
    anchor.virtualizer.options.scrollToFn = (offset, options, native) => {
      anchorState.nativeWrites.push({ offset, adjustments: options.adjustments ?? 0, behavior: options.behavior })
      scroll(offset, options, native)
    }
    return anchor
  } }
})
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => React.createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value) }))

beforeEach(() => { anchorState.nativeWrites = []; installMessageScrollFixture() })
afterEach(restoreMessageScrollFixture)

function message(index: number) {
  return { id: `m${index}`, type: "chat" as const, authorId: "alice", authorName: "Alice", content: "Message", createdAt: new Date(index * 1000).toISOString() }
}

function visibleMessage(root: HTMLElement) {
  const viewport = root.getBoundingClientRect()
  return Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(body => {
    const rect = body.getBoundingClientRect()
    return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
  })
}

function messageOffset(root: HTMLElement, id: string) {
  const body = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(node => node.dataset.msgId === id)
  return body ? body.getBoundingClientRect().top - root.getBoundingClientRect().top : null
}

describe("MessageList continuous input through an accepted page", () => {
  it.each([
    ["older", "response-first", "edge"], ["older", "rows-first", "edge"],
    ["newer", "response-first", "edge"], ["newer", "rows-first", "edge"],
    ["older", "response-first", "away"], ["older", "rows-first", "away"],
    ["newer", "response-first", "away"], ["newer", "rows-first", "away"],
  ] as const)("keeps the current reading point for %s %s while scrolling at %s", async (direction, order, position) => {
    let messages = Array.from({ length: 50 }, (_, index) => message(index + 40))
    const before = {}, received = {}
    let complete!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>(resolve => { complete = resolve })
    const request = { accepted: true as const, completed }
    const older = vi.fn(() => direction === "older" ? request : { accepted: false as const })
    const newer = vi.fn(() => direction === "newer" ? request : { accepted: false as const })
    const view = (window = before, fetching = false) => React.createElement(MessageList, {
      channel: "general", messages, messageWindow: window, initialScrollReady: true,
      initialPositionMessageId: "m65", positionDataState: "ready", hasMore: true, hasMoreNewer: true,
      isFetchingOlder: fetching && direction === "older", isFetchingNewer: fetching && direction === "newer",
      onLoadOlder: older, onLoadNewer: newer, onOpenThread: vi.fn(),
    })
    const renderer = render(view())
    resize()
    const root = renderer.getByTestId(tid.messageScroller)
    const trace: Array<Record<string, unknown>> = []
    let writeCount = 0
    let nativeWriteCount = 0
    const record = (phase: string, input: Record<string, unknown> = {}) => {
      const viewport = root.getBoundingClientRect()
      const native = anchorState.current!.virtualizer
      const candidate = native.getVirtualItemForOffset(native.scrollOffset ?? 0)
      trace.push({ phase, time: performance.now(), timerTime: Date.now(), itemCount: messages.length, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight,
        anchorTo: native.options.anchorTo, nativeOffset: native.scrollOffset, isScrolling: native.isScrolling,
        candidate: candidate ? { key: candidate.key, index: candidate.index, start: candidate.start, end: candidate.end } : null,
        paginationPending: anchorState.current!.paginationRequestPending,
        visible: Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).flatMap(body => {
          const rect = body.getBoundingClientRect()
          return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
            ? [{ id: body.dataset.msgId, offset: rect.top - viewport.top }] : []
        }), writes: scrollFixture.scrollCalls.slice(writeCount), nativeWrites: anchorState.nativeWrites.slice(nativeWriteCount), ...input })
      writeCount = scrollFixture.scrollCalls.length
      nativeWriteCount = anchorState.nativeWrites.length
    }
    onTestFinished(() => {
      if (process.env.ALOOK_SCROLL_TRACE === "1") process.stdout.write(`MESSAGE_PAGE_INPUT_TRACE ${JSON.stringify({ direction, order, position, trace })}\n`)
    })
    record("initial-ready")
    expect(root.querySelector('[data-read-position-ready="true"]')).not.toBeNull()
    expect(older).not.toHaveBeenCalled()
    expect(newer).not.toHaveBeenCalled()
    const edge = direction === "older" ? 0 : root.scrollHeight - root.clientHeight
    fireEvent.wheel(root, { deltaY: edge - root.scrollTop })
    act(() => root.scrollTo({ top: edge }))
    resize(0)
    runFrames(1)
    const load = direction === "older" ? older : newer
    expect(load).toHaveBeenCalledOnce()
    record("accepted-page")
    renderer.rerender(view(before, true))
    for (let step = 1; step <= 3; step++) {
      const delta = (direction === "older" ? -1 : 1) * (position === "edge" ? 30 : -120)
      const previous = root.scrollTop
      const max = Math.max(0, root.scrollHeight - root.clientHeight)
      const offset = Math.max(0, Math.min(previous + delta, max))
      fireEvent.wheel(root, { deltaY: delta })
      act(() => root.scrollTo({ top: offset }))
      expect((root.scrollTop - previous) * delta).toBeGreaterThanOrEqual(0)
      expect(root.scrollTop).toBeCloseTo(offset, 0)
      runFrames(1)
      record(`pending-input-${step}`, { wheelDelta: delta, requestedTop: offset })
      if (position === "edge") expect(direction === "older" ? root.scrollTop : root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    }
    const body = visibleMessage(root)
    expect(body).toBeDefined()
    const readingId = body!.dataset.msgId!
    const currentOffset = messageOffset(root, readingId)!
    record("before-response", { readingId, readingOffset: currentOffset })
    const publishRows = () => {
      messages = direction === "older"
        ? [...Array.from({ length: 39 }, (_, index) => message(index + 1)), ...messages]
        : [...messages, ...Array.from({ length: 39 }, (_, index) => message(index + 90))]
    }
    if (order === "rows-first") {
      publishRows()
      renderer.rerender(view(before, true))
      resize(0)
      runFrames(1)
      record("rows-before-receipt")
      expect(messageOffset(root, readingId), `${direction}/${position}: rows commit before receipt preserves the reading body`).toBeCloseTo(currentOffset, 0)
    }
    await act(async () => { complete({ status: "success", window: received }) })
    record("receipt-completed")
    if (order === "response-first") publishRows()
    renderer.rerender(view(received))
    resize(0)
    runFrames(1)
    record("response-and-first-measurement")
    const afterResponse = messageOffset(root, readingId)
    expect(afterResponse, `${direction}/${order}/${position}: current reading row ${readingId} remains mounted`).not.toBeNull()
    expect(Math.abs(afterResponse! - currentOffset), `${direction}/${order}/${position}: response preserves current visible message`).toBeLessThanOrEqual(1)
    let expectedOffset = currentOffset
    for (let step = 1; step <= 3; step++) {
      const delta = direction === "older" ? -20 : 20
      const previous = root.scrollTop
      const inputDelta = Math.max(0, Math.min(previous + delta, root.scrollHeight - root.clientHeight)) - previous
      expectedOffset -= inputDelta
      fireEvent.wheel(root, { deltaY: delta })
      act(() => root.scrollTo({ top: previous + delta }))
      runFrames(1)
      record(`post-response-input-${step}`, { wheelDelta: delta, requestedTop: previous + delta })
      resize(0)
      runFrames(1)
      record(`post-input-measurement-${step}`)
      const afterInput = messageOffset(root, readingId)
      expect(afterInput).not.toBeNull()
      expect(Math.abs(afterInput! - expectedOffset)).toBeLessThanOrEqual(1)
    }
    const settled = root.scrollTop
    runFrames(12)
    resize(0)
    record("final-quiet-control")
    expect(root.scrollTop).toBeCloseTo(settled, 0)
    expect(load).toHaveBeenCalledOnce()
  })
})
