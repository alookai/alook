import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

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
