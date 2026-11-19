import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture, bodyTop } from "@/test/message-scroll-fixture"

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
