import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageRequestResult, NewPositionRequest } from "@/lib/community/message-position"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function reducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" && matches })))
}

it.each([false, true])("keeps placement immediate and applies the shared bottom policy (reduced=%s)", reduced => {
  reducedMotion(reduced)
  const h = mount({}, false, undefined, undefined, 0)
  const native = scrollFixture.latest.virtualizer
  const end = vi.spyOn(native, "scrollToEnd")
  resize()
  expect(end).toHaveBeenCalledExactlyOnceWith({ behavior: "auto" })
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  h.move(300)
  end.mockClear()
  act(() => scrollFixture.latest.scrollToBottom())
  resize()
  expect(end).toHaveBeenCalledExactlyOnceWith({ behavior: reduced ? "auto" : "smooth" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
})

it.each([false, true])("follows an eligible append with the shared policy and protects history (reduced=%s)", reduced => {
  reducedMotion(reduced)
  const h = mount()
  const native = scrollFixture.latest.virtualizer
  const end = vi.spyOn(native, "scrollToEnd")
  h.update({ items: [...h.input.items, message("new-peer")] })
  expect(end).toHaveBeenCalledExactlyOnceWith({ behavior: reduced ? "auto" : "smooth" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  h.move(300)
  end.mockClear()
  const before = h.root.scrollTop
  h.update({ items: [...h.input.items, message("later-peer")] })
  expect(end).not.toHaveBeenCalled()
  expect(h.root.scrollTop).toBe(before)
})

it.each([false, true])("uses the shared New policy after its target qualifies (reduced=%s)", async reduced => {
  reducedMotion(reduced)
  const items = Array.from({ length: 18 }, (_, index) => ({ ...message(`m${index}`), newDivider: index === 4 }))
  const h = mount({ items, newDividerBefore: "m4" })
  const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
  let request!: NewPositionRequest
  act(() => { request = scrollFixture.latest.requestNewPosition("m4") })
  expect(request.accepted).toBe(true)
  resize()
  expect(index).toHaveBeenCalledWith(5, { align: "start", behavior: reduced ? "auto" : "smooth" })
  expect(h.root.querySelector('[data-new-divider]')!.getBoundingClientRect().top).toBeCloseTo(0, 0)
  if (!request.accepted) throw new Error("New positioning was rejected")
  await expect(request.completed).resolves.toBe("success")
})

it.each([false, true])("waits for a qualified Present window before smooth positioning (reduced=%s)", async reduced => {
  reducedMotion(reduced)
  const previous = {}, next = {}
  const h = mount({ messageWindow: previous, hasMoreNewer: true })
  h.move(300)
  const before = h.root.scrollTop
  const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
  let finish!: (result: MessageRequestResult) => void
  const completed = new Promise<MessageRequestResult>(resolve => { finish = resolve })
  act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
  runFrames(2)
  expect(end).not.toHaveBeenCalled()
  expect(h.root.scrollTop).toBe(before)
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  await act(async () => finish({ status: "success", window: next }))
  expect(end).not.toHaveBeenCalled()
  h.update({ messageWindow: next, hasMoreNewer: false })
  expect(end).toHaveBeenCalledWith({ behavior: reduced ? "auto" : "smooth" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
})

it("keeps explicit instant navigation and reduces an explicit smooth quote", () => {
  reducedMotion(true)
  const h = mount()
  const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
  act(() => scrollFixture.latest.jumpTo("m4", "smooth"))
  resize()
  expect(index).toHaveBeenCalledWith(5, { align: "center", behavior: "auto" })
  index.mockClear()
  act(() => scrollFixture.latest.jumpTo("m8", "instant"))
  resize()
  expect(index).toHaveBeenCalledWith(9, { align: "center", behavior: "instant" })
})

it.each([false, true])("uses the same policy after an accepted local send (reduced=%s)", reduced => {
  reducedMotion(reduced)
  const h = mount()
  h.move(300)
  const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
  h.update({ localSubmitVersion: 1 })
  expect(end).toHaveBeenCalledWith({ behavior: reduced ? "auto" : "smooth" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
})

it("keeps viewport correction immediate even when navigation uses smooth", () => {
  reducedMotion(false)
  const h = mount()
  h.move(h.root.scrollHeight - h.root.clientHeight - 2)
  const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
  scrollFixture.height += 100
  resize(2)
  expect(offset).toHaveBeenCalledWith(expect.any(Number), { behavior: "auto" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
})

it.each([[false, 0], [true, 0], [false, 2], [false, 100], [false, 300]] as const)("keeps consecutive viewport shrinks aligned (reduced=%s, distance=%ipx)", (reduced, distance) => {
  reducedMotion(reduced)
  const h = mount()
  if (distance > 0) h.move(h.root.scrollHeight - h.root.clientHeight - distance)
  const before = h.root.scrollTop
  for (let frame = 0; frame < 3; frame++) {
    scrollFixture.height -= 20
    resize(2)
    if (distance <= 100) expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(distance)
    else expect(h.root.scrollTop).toBe(before)
  }
})

it.each(["wheel", "touch", "pointer", "unlabelled"] as const)("protects %s takeover after a viewport correction", input => {
  reducedMotion(false)
  const h = mount()
  scrollFixture.height -= 20
  resize(2)
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
  const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
  act(() => {
    if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -20 })
    if (input === "touch") fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    if (input === "pointer") fireEvent.pointerDown(h.root, { pointerId: 11 })
    h.root.scrollTo({ top: h.root.scrollTop - 5 })
  })
  runFrames(1)
  const before = h.root.scrollTop
  offset.mockClear()
  scrollFixture.height -= 20
  resize(2)
  expect(offset).not.toHaveBeenCalled()
  expect(h.root.scrollTop).toBe(before)
})
