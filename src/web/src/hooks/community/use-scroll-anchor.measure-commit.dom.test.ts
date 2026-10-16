import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { screen } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("native row measurement commits the matching viewport geometry", () => {
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
