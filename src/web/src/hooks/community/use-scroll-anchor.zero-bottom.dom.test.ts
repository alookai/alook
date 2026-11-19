import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, resizeMeasureBeforeScroll, runFrames, scrollFixture, bodyTop } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function tallTail(overrides: Parameters<typeof mount>[0] = {}) {
  scrollFixture.bodyHeights.set("m13", 1200)
  const h = mount(overrides)
  h.move(h.root.scrollHeight - h.root.clientHeight - 600)
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.virtualizer.isAtEnd(40)).toBe(false)
  return h
}

it("restores follow at zero before an append in the same commit", () => {
  const h = tallTail()
  const native = scrollFixture.latest.virtualizer
  const end = vi.spyOn(native, "scrollToEnd")
  act(() => {
    fireEvent.wheel(h.root, { deltaY: 20 })
    h.stage({ items: [...h.input.items, message("received-with-zero")] })
  })
  resize()
  expect(end).toHaveBeenCalledOnce()
  expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
})

it("anchors keyboard viewport changes at zero while keeping the read-tail fact separate", () => {
  const h = tallTail()
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  expect(scrollFixture.latest.followingTail).toBe(true)
  expect(scrollFixture.latest.readingTail).toBe(false)
  const before = h.root.scrollTop
  scrollFixture.height -= 160
  resize()
  expect(h.root.scrollTop).toBe(before + 160)
  expect(scrollFixture.latest.followingTail).toBe(true)
})

it("keeps upward takeover at zero until a downward action restores follow", () => {
  const h = tallTail()
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  fireEvent.wheel(h.root, { deltaY: -20 })
  act(() => h.root.scrollTo({ top: h.root.scrollTop - 20 }))
  runFrames()
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.followingTail).toBe(false)
  const before = h.root.scrollTop
  h.update({ items: [...h.input.items, message("peer-while-reading")] })
  expect(h.root.scrollTop).toBe(before)
})

it("keeps unloaded newer pages independent of a zero loaded-window count", () => {
  scrollFixture.bodyHeights.set("m13", 1200)
  const h = mount({ hasMoreNewer: true })
  h.move(h.root.scrollHeight - h.root.clientHeight - 600)
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.jumpToPresentVisible).toBe(true)
  expect(scrollFixture.latest.followingTail).toBe(false)
})

it("resumes a hidden zero-count tail only after its new layout qualifies", () => {
  const h = tallTail()
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  h.update({ active: false })
  h.update({ items: [...h.input.items, message("hidden-peer")] })
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  h.update({ active: true })
  expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
})

it("counts unmounted newer rows and restores only at the loaded virtual tail", () => {
  scrollFixture.bodyHeights.set("m119", 1200)
  const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)) })
  h.move(300)
  expect(scrollFixture.latest.belowCount).toBeGreaterThan(60)
  expect(h.root.querySelectorAll("[data-msg-id]").length).toBeLessThan(60)
  h.move(h.root.scrollHeight - h.root.clientHeight - 600)
  expect(scrollFixture.latest.belowCount).toBe(0)
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  h.update({ items: [...h.input.items, message("virtual-tail-peer")] })
  expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
})

it("keeps renderer presentation read and page gates closed during zero-count viewport follow", () => {
  const reading = vi.fn()
  const h = tallTail({ onReadingMessage: reading })
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  expect(scrollFixture.latest.followingTail).toBe(true)
  expect(scrollFixture.latest.readingTail).toBe(false)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  reading.mockClear()
  h.update({ presentationRevision: 1 })
  expect(h.view.getByTestId("scroll")).toBe(h.root)
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  expect(scrollFixture.latest.paginationEnabled).toBe(false)
  const before = h.root.scrollTop
  scrollFixture.height -= 100
  resize()
  expect(h.root.scrollTop).toBe(before + 100)
  expect(scrollFixture.latest.readingTail).toBe(false)
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  expect(scrollFixture.latest.paginationEnabled).toBe(false)
  expect(reading).not.toHaveBeenCalled()
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  expect(scrollFixture.latest.paginationEnabled).toBe(true)
})


it.each(["wheel", "scroll"])("retains the upward body through idle and reading publication after %s input", input => {
  scrollFixture.bodyHeights.set("m13", 2901)
  const reading = vi.fn()
  const h = mount({ onReadingMessage: reading })
  const start = h.root.scrollTop
  if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -600 })
  act(() => h.root.scrollTo({ top: start - 600 }))
  runFrames()
  const before = h.root.scrollTop
  const body = bodyTop(h.root, "m13")
  act(() => vi.advanceTimersByTime(54000))
  runFrames()
  h.update({ items: [...h.input.items] })
  expect(h.root.scrollTop).toBe(before)
  expect(bodyTop(h.root, "m13")).toBe(body)
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.followingTail).toBe(false)
  h.update({ items: [...h.input.items, message("peer-after-idle")] })
  expect(h.root.scrollTop).toBe(before)
  expect(bodyTop(h.root, "m13")).toBe(body)
  h.move(h.root.scrollHeight - h.root.clientHeight - 60)
  expect(scrollFixture.latest.belowCount).toBe(0)
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  h.update({ items: [...h.input.items, message("peer-after-recovery")] })
  expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
})


it("does not treat a downward geometry adjustment as new intent after upward takeover", () => {
  const h = tallTail({ onReadingMessage: vi.fn() })
  fireEvent.wheel(h.root, { deltaY: -20 })
  act(() => h.root.scrollTo({ top: h.root.scrollTop - 20 }))
  runFrames()
  act(() => h.root.scrollTo({ top: h.root.scrollTop + 2 }))
  runFrames()
  const before = h.root.scrollTop
  expect(scrollFixture.latest.followingTail).toBe(false)
  h.update({ items: [...h.input.items, message("peer-after-adjustment")] })
  expect(h.root.scrollTop).toBe(before)
})


it.each([41, 600])("keeps the reading position selected %ipx before the tail while the composer rectangle is pending", distance => {
  scrollFixture.height = 1161
  scrollFixture.width = 883
  scrollFixture.bodyHeights.set("m13", 2901.421875)
  const h = mount({ onReadingMessage: vi.fn() })
  const height = scrollFixture.height
  scrollFixture.height -= 168
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight - distance }))
  runFrames(2)
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(distance)
  const before = h.root.scrollTop, body = bodyTop(h.root, "m13")
  resize()
  expect(Math.abs(h.root.scrollTop - before)).toBeLessThanOrEqual(1)
  expect(Math.abs(bodyTop(h.root, "m13") - body)).toBeLessThanOrEqual(1)
  act(() => vi.advanceTimersByTime(155470))
  runFrames()
  if (distance === 41) {
    scrollFixture.height = height
    resize()
    expect(Math.abs(h.root.scrollTop - Math.min(before, h.root.scrollHeight - h.root.clientHeight))).toBeLessThanOrEqual(1)
  } else {
    h.update({ items: [...h.input.items, message("peer-after-composer-handoff")] })
    expect(Math.abs(h.root.scrollTop - before)).toBeLessThanOrEqual(1)
    expect(Math.abs(bodyTop(h.root, "m13") - body)).toBeLessThanOrEqual(1)
  }
})

it.each([
  { height: 563, growth: 120, width: 905, order: "scroll-first" },
  { height: 563, growth: 120, width: 905, order: "measure-first" },
  { height: 993, growth: 168, width: 883, order: "scroll-first" },
  { height: 993, growth: 168, width: 883, order: "measure-first" },
])("preserves a one-pixel reading takeover at $height px with $order resize delivery", ({ height, growth, width, order }) => {
  scrollFixture.height = height
  scrollFixture.width = width
  scrollFixture.bodyHeights.set("m13", 2901.421875)
  const h = mount({ onReadingMessage: vi.fn() })
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight - 40 }))
  runFrames()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(40)
  act(() => h.root.scrollTo({ top: h.root.scrollTop - 1 }))
  runFrames()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(41)
  expect(scrollFixture.latest.belowCount).toBe(0)
  expect(scrollFixture.latest.followingTail).toBe(false)
  const before = h.root.scrollTop
  const body = h.root.querySelector('[data-msg-id="m13"]')
  const offset = bodyTop(h.root, "m13")
  scrollFixture.height += growth
  if (order === "measure-first") resizeMeasureBeforeScroll()
  else resize()
  const expected = Math.min(before, Math.max(0, h.root.scrollHeight - h.root.clientHeight))
  expect(Math.abs(h.root.scrollTop - expected)).toBeLessThanOrEqual(1)
  expect(h.root.querySelector('[data-msg-id="m13"]')).toBe(body)
  expect(body?.isConnected).toBe(true)
  expect(Math.abs(bodyTop(h.root, "m13") - (offset + before - expected))).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.followingTail).toBe(false)
  fireEvent.wheel(h.root, { deltaY: 20 })
  runFrames()
  expect(scrollFixture.latest.followingTail).toBe(true)
})

it.each([0, 2, 40])("retains the %ipx tail distance through composer shrink", distance => {
  scrollFixture.height = 563
  scrollFixture.width = 905
  scrollFixture.bodyHeights.set("m13", 2901.421875)
  const h = mount()
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight - distance }))
  runFrames()
  scrollFixture.height += 120
  resize()
  expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - distance)).toBeLessThanOrEqual(1)
})

it("keeps subpixel tail-boundary noise outside the one-pixel takeover", () => {
  scrollFixture.height = 563
  scrollFixture.bodyHeights.set("m13", 2901.421875)
  const h = mount()
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight - 40 }))
  runFrames()
  act(() => h.root.scrollTo({ top: h.root.scrollTop - 0.5 }))
  runFrames()
  scrollFixture.height += 120
  resize()
  expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - 40.5)).toBeLessThanOrEqual(1)
})

it("does not take reading ownership from a one-pixel viewport change without upward movement", () => {
  scrollFixture.height = 563
  scrollFixture.bodyHeights.set("m13", 2901.421875)
  const h = mount()
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight - 40 }))
  runFrames()
  scrollFixture.height -= 1
  act(() => h.root.dispatchEvent(new Event("scroll")))
  resize()
  expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - 40)).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.followingTail).toBe(true)
})


it.each([0, 2, 26].flatMap(frames => [
  { frames, order: "scroll-first" },
  { frames, order: "measure-first" },
]))("preserves reading after the complete composer resize history with $frames-frame $order delivery", ({ frames, order }) => {
  scrollFixture.height = 683
  scrollFixture.width = 905
  const items = Array.from({ length: 36 }, (_, index) => message(`dm-history-${index}`))
  const h = mount({ items, onReadingMessage: vi.fn() })
  const deliverResize = () => order === "measure-first" ? resizeMeasureBeforeScroll(frames || 26) : resize(frames || 26)
  let pendingResize = false
  const setDistance = (distance: number) => {
    act(() => {
      h.root.scrollTop = Math.max(0, h.root.scrollHeight - h.root.clientHeight - distance)
      h.root.dispatchEvent(new Event("scroll"))
    })
    if (pendingResize) {
      pendingResize = false
      deliverResize()
    } else runFrames()
    if (frames === 0) {
      if (Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - distance) > 1) {
        act(() => {
          h.root.scrollTop = Math.max(0, h.root.scrollHeight - h.root.clientHeight - distance)
          h.root.dispatchEvent(new Event("scroll"))
        })
        runFrames()
      }
      expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - distance)).toBeLessThanOrEqual(1)
    } else expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(distance)
  }
  for (const distance of [0, 2, 40, 41]) {
    scrollFixture.height = 563
    if (frames === 0) pendingResize = true
    else deliverResize()
    if (distance === 0) setDistance(41)
    setDistance(distance)
    expect(scrollFixture.latest.belowCount).toBe(0)
    const before = h.root.scrollTop
    const body = h.root.querySelector('[data-msg-id="dm-history-35"]')
    const offset = bodyTop(h.root, "dm-history-35")
    scrollFixture.height = 683
    deliverResize()
    if (distance <= 40) {
      expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - distance)).toBeLessThanOrEqual(1)
    } else {
      const expected = Math.min(before, Math.max(0, h.root.scrollHeight - h.root.clientHeight))
      expect(Math.abs(h.root.scrollTop - expected)).toBeLessThanOrEqual(1)
      expect(h.root.querySelector('[data-msg-id="dm-history-35"]')).toBe(body)
      expect(body?.isConnected).toBe(true)
      expect(Math.abs(bodyTop(h.root, "dm-history-35") - (offset + before - expected))).toBeLessThanOrEqual(1)
      expect(scrollFixture.latest.followingTail).toBe(false)
    }
  }
})
