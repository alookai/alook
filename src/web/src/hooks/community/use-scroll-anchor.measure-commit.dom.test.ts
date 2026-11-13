import type { MessageRequestResult } from "@/lib/community/message-position"
import { createElement, useCallback } from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

const commitGate = vi.hoisted(() => ({ hold: false, publish: undefined as (() => void) | undefined }))
vi.mock("@/components/community/messages/virtual-cursor-list", async original => {
  const actual = await original<typeof import("@/components/community/messages/virtual-cursor-list")>()
  return { ...actual, VirtualRows: function HeldCommitRows(props: Parameters<typeof actual.VirtualRows>[0]) {
    const { onLayoutCommit } = props
    const commit = useCallback<NonNullable<typeof props.onLayoutCommit>>(layout => {
      if (commitGate.hold && layout) commitGate.publish = () => onLayoutCommit?.(layout)
      else onLayoutCommit?.(layout)
    }, [onLayoutCommit])
    return createElement(actual.VirtualRows, { ...props, onLayoutCommit: commit })
  } }
})

beforeEach(() => { commitGate.hold = false; commitGate.publish = undefined })
beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("native row measurement commits the matching viewport geometry", () => {
  it.each([false, true])("preserves a reading row through repeated above-fold growth during backward input (StrictMode=%s)", strict => {
    const h = mount({ items: Array.from({ length: 50 }, (_, i) => message(`m${i}`)), hasMoreOlder: false }, strict)
    h.move(700)
    fireEvent.wheel(h.root, { deltaY: -150 })
    act(() => h.root.scrollTo({ top: 550 }))
    resize(0)
    const native = scrollFixture.latest.virtualizer
    expect(native.scrollDirection).toBe("backward")
    const anchor = native.getVirtualItemForOffset(h.root.scrollTop + 1)
    const above = native.getVirtualItems().find(row => String(row.key).startsWith("msg:") && row.end <= h.root.scrollTop)
    if (!anchor || !above) throw new Error("Measured reading and above-fold rows are required")
    const readingId = String(anchor.key).slice(4)
    const growingId = String(above.key).slice(4)
    expect(native.itemSizeCache.has(above.key)).toBe(true)
    const before = { top: bodyTop(h.root, readingId), offset: h.root.scrollTop }
    let growth = 0
    for (const delta of [100, 80]) {
      growth += delta
      scrollFixture.bodyHeights.set(growingId, above.size + growth)
      resize(0)
      expect(bodyTop(h.root, readingId)).toBeCloseTo(before.top, 0)
      expect(h.root.scrollTop).toBeCloseTo(before.offset + growth, 0)
      runFrames(1)
    }
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it.each(["spanning", "below"])("keeps the reading point when a %s row grows during backward input", location => {
    const h = mount({ items: Array.from({ length: 50 }, (_, i) => message(`m${i}`)), hasMoreOlder: false })
    h.move(700)
    fireEvent.wheel(h.root, { deltaY: -150 })
    act(() => h.root.scrollTo({ top: 550 }))
    resize(0)
    const native = scrollFixture.latest.virtualizer
    expect(native.scrollDirection).toBe("backward")
    const reading = native.getVirtualItemForOffset(h.root.scrollTop + 1)!
    const growing = location === "spanning" ? reading : native.getVirtualItems().find(row => row.start >= h.root.scrollTop + h.root.clientHeight)!
    expect(growing).toBeDefined()
    const readingId = String(reading.key).slice(4)
    const before = { top: bodyTop(h.root, readingId), offset: h.root.scrollTop }
    scrollFixture.bodyHeights.set(String(growing.key).slice(4), growing.size + 80)
    resize(0)
    expect(bodyTop(h.root, readingId)).toBeCloseTo(before.top, 0)
    expect(h.root.scrollTop).toBeCloseTo(before.offset, 0)
  })

  it.each([
    ["tail", false], ["reader", false], ["tail", true], ["reader", true],
  ] as const)("keeps %s geometry coherent before observer delivery returns (StrictMode=%s)", (position, strict) => {
    type Receipt = { total: number; height: number; top: number }
    let capture: (() => void) | undefined
    const NativeObserver = globalThis.ResizeObserver
    vi.stubGlobal("ResizeObserver", class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => { callback(entries, observer); capture?.() })
      }
    })
    const h = mount({ items: Array.from({ length: 50 }, (_, i) => message(`m${i}`)), hasMoreOlder: false }, strict)
    if (position === "reader") h.move(600)
    const scroller = screen.getByTestId("scroll")
    const native = scrollFixture.latest.virtualizer
    const row = native.getVirtualItems().find(item => typeof item.key === "string"
      && item.key.startsWith("msg:") && item.start + item.size <= scroller.scrollTop)
    expect(row).toBeDefined()
    if (!row) throw new Error("An above-fold row is required for the resize stimulus")
    const before = { top: scroller.scrollTop, total: native.getTotalSize(), height: scroller.scrollHeight }
    expect(before.total).toBe(before.height)
    scrollFixture.bodyHeights.set(String(row.key).slice(4), row.size + 100)
    let receipt: Receipt | undefined
    capture = () => {
      if (!receipt && native.getTotalSize() !== before.total) {
        receipt = { total: native.getTotalSize(), height: scroller.scrollHeight, top: scroller.scrollTop }
      }
    }
    resize(0)
    capture = undefined
    expect(receipt).toBeDefined()
    expect(receipt?.total).toBe(before.total + 100)
    expect(receipt?.height).toBe(receipt?.total)
    expect(receipt?.top).toBe(before.top + 100)
    runFrames()
    expect(scroller.scrollTop).toBe(before.top + 100)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
})

describe("manual reading waits for the real matching row commit", () => {
  function pendingReader() {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    reading.mockClear()
    commitGate.hold = true
    fireEvent.wheel(h.root, { deltaY: -800 })
    act(() => h.root.scrollTo({ top: 0 }))
    runFrames(1)
    expect(commitGate.publish).toBeDefined()
    expect(reading).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    return { h, reading }
  }
  function publishRows() {
    const publish = commitGate.publish
    if (!publish) throw new Error("An actual held row-layout callback is required")
    commitGate.hold = false
    act(() => publish())
  }
  function actualReadingBody(root: HTMLElement) {
    const viewport = root.getBoundingClientRect()
    return Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(body => {
      const rect = body.getBoundingClientRect()
      return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
    })?.dataset.msgId
  }
  it("stays dormant without a commit and wakes once from the real callback without pagination or another movement", () => {
    const { h, reading } = pendingReader()
    try {
      fireEvent.wheel(h.root, { deltaY: -800 })
      runFrames(40)
      expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const requests = vi.mocked(window.requestAnimationFrame).mock.calls.length
      runFrames(8)
      expect(vi.mocked(window.requestAnimationFrame).mock.calls).toHaveLength(requests)
      expect(scrollFixture.latest.paginationRequestPending).toBe(false)
      const before = h.root.scrollTop
      publishRows()
      runFrames(2)
      expect(h.root.scrollTop).toBe(before)
      expect(actualReadingBody(h.root)).toBe("m0")
      expect(reading).toHaveBeenCalledExactlyOnceWith("m0")
      resize(50)
      fireEvent.scroll(h.root)
      runFrames(4)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["target", "present", "hidden"] as const)("does not carry cancelled movement through %s retirement before the next frame", async retirement => {
    const { h, reading } = pendingReader()
    let finishPresent: ((result: MessageRequestResult) => void) | undefined
    try {
      if (retirement === "target") h.stage({ scrollToMessageId: "m20" })
      else if (retirement === "present") {
        const completed = new Promise<MessageRequestResult>(resolve => { finishPresent = resolve })
        act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
        expect(scrollFixture.latest.presentPositionPending).toBe(true)
      }
      else { h.stage({ active: false }); h.stage({ active: true }) }
      expect(h.root.scrollTop).toBe(0)
      fireEvent.wheel(h.root, { deltaY: -800 })
      publishRows()
      runFrames(40)
      expect(h.root.scrollTop).toBe(0)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(actualReadingBody(h.root)).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
    } finally {
      if (finishPresent) await act(async () => finishPresent?.({ status: "cancelled" }))
      commitGate.hold = false
      h.view.unmount()
    }
  })
})
