import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("presentation read and page admission", () => {
  it("keeps the owner and blocks read/page admission until native user intent", () => {
    const reading = vi.fn()
    const rows = Array.from({ length: 50 }, (_, i) => message(`m${i}`))
    const h = mount({ items: rows, onReadingMessage: reading, initialPositionMessageId: "m20", hasMoreNewer: true })
    const root = h.root
    const before = reading.mock.calls.length
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h.update({ presentationRevision: 1 })
    resize()
    expect(h.root).toBe(root)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(false)
    expect(reading).toHaveBeenCalledTimes(before)
    act(() => scrollFixture.latest.jumpTo("missing-message"))
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    act(() => expect(scrollFixture.latest.requestNewPosition("missing-new-boundary")).toEqual({ accepted: false }))
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    fireEvent.wheel(root, { deltaY: -20 })
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
  })

  it("admits a real new tail and explicit navigation, while a failed cell stays unreadable", () => {
    const rows = Array.from({ length: 40 }, (_, i) => message(`m${i}`))
    const h = mount({ items: rows })
    h.update({ presentationRevision: 1 })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ items: [...rows, message("new-peer-tail")] })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h.update({ presentationRevision: 2, presentationAvailable: false })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    fireEvent.wheel(h.root, { deltaY: -20 })
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ presentationRevision: 3, presentationAvailable: true })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    fireEvent.keyDown(h.root, { key: "End" })
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("preserves the committed body through presentation changes and resumes actual reading on new displacement", () => {
    const reading = vi.fn()
    const rows = Array.from({ length: 80 }, (_, index) => message(`m${index}`))
    const h = mount({ items: rows, onReadingMessage: reading, initialPositionMessageId: "m40", hasMoreNewer: true })
    const root = h.root
    const firstBody = () => {
      const viewport = root.getBoundingClientRect()
      return [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(body => {
        const rect = body.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
      })?.dataset.msgId
    }
    const anchor = firstBody()
    if (!anchor) throw new Error("A committed visible message body is required")
    const offset = bodyTop(root, anchor) - root.getBoundingClientRect().top
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    reading.mockClear()
    for (const presentationRevision of [1, 2, 3]) {
      const above = scrollFixture.latest.virtualizer.getVirtualItems().find(row => String(row.key).startsWith("msg:") && row.end <= root.scrollTop)
      if (!above) throw new Error("A measured above-fold row is required")
      const before = { total: scrollFixture.latest.virtualizer.getTotalSize(), offset: root.scrollTop }
      h.stage({ presentationRevision })
      const id = String(above.key).slice(4)
      scrollFixture.bodyHeights.set(id, (scrollFixture.bodyHeights.get(id) ?? 100) + 32)
      resize()
      expect(scrollFixture.latest.virtualizer.itemSizeCache.get(above.key)).toBeCloseTo(above.size + 32, 0)
      expect(scrollFixture.latest.virtualizer.getTotalSize()).toBeCloseTo(before.total + 32, 0)
      expect(root.scrollTop).toBeCloseTo(before.offset + 32, 0)
      expect(h.view.getByTestId("scroll")).toBe(root)
      expect(firstBody()).toBe(anchor)
      expect(bodyTop(root, anchor) - root.getBoundingClientRect().top).toBeCloseTo(offset, 0)
      const container = root.querySelector<HTMLElement>("[data-message-list-content] > div")!
      expect(Number.parseFloat(container.style.height)).toBeCloseTo(scrollFixture.latest.virtualizer.getTotalSize(), 0)
      expect(scrollFixture.latest.readPositionReady).toBe(false)
      expect(scrollFixture.latest.paginationEnabled).toBe(false)
      expect(reading).not.toHaveBeenCalled()
    }
    const before = root.scrollTop
    h.move(before - 160)
    resize()
    expect(root.scrollTop).toBeLessThan(before)
    expect(firstBody()).toBeDefined()
    expect(firstBody()).not.toBe(anchor)
    expect(reading).toHaveBeenCalledExactlyOnceWith(firstBody())
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
  })
})
