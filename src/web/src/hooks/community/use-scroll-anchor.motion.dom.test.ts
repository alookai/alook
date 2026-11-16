import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
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
  const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
  scrollFixture.height -= 100
  resize(2)
  expect(offset).toHaveBeenCalledWith(expect.any(Number), { behavior: "auto" })
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
})

it("waits for the keyboard viewport before issuing a loaded-tail command", () => {
  const h = mount()
  h.move(300)
  const native = scrollFixture.latest.virtualizer
  const end = vi.spyOn(native, "scrollToEnd")
  scrollFixture.height -= 200
  act(() => scrollFixture.latest.scrollToBottom())
  expect(native.scrollRect?.height).not.toBe(h.root.clientHeight)
  expect(end).not.toHaveBeenCalled()
  resize()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  expect(scrollFixture.latest.followingTail).toBe(true)
  runFrames(140)
  expect(scrollFixture.frames.size).toBe(0)
})

it.each(["reading", "quote"] as const)("does not revive a late-growing present tail after %s takes ownership", action => {
  scrollFixture.height -= 180
  const positioned = vi.fn()
  const h = mount({ onScrollTargetPositioned: positioned })
  h.move(300)
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  const actualBounds = bounds.getMockImplementation()!
  bounds.mockImplementation(function (this: HTMLElement) {
    return this.matches("[data-index]") ? DOMRect.fromRect() : actualBounds.call(this)
  })
  act(() => scrollFixture.latest.scrollToBottom())
  runFrames()
  const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
  if (action === "reading") {
    fireEvent.wheel(h.root, { deltaY: -20 })
    act(() => h.root.scrollTo({ top: 300 }))
  } else h.stage({ scrollToMessageId: "m4" })
  bounds.mockImplementation(actualBounds)
  scrollFixture.bodyHeights.set("m13", 360)
  resize()
  expect(end).not.toHaveBeenCalled()
  expect(scrollFixture.latest.followingTail).toBe(false)
  if (action === "reading") {
    expect(h.root.scrollTop).toBe(300)
    expect(positioned).not.toHaveBeenCalled()
  } else expect(positioned).toHaveBeenCalledExactlyOnceWith("m4")
})

it.each(["loaded", "requested", "submit"] as const)("finishes %s at the open-keyboard tail and follows after composer clear", async action => {
  const previous = {}, next = {}
  const h = mount({ messageWindow: previous, hasMoreNewer: action === "requested" })
  scrollFixture.height -= 180
  resize()
  h.move(300)
  if (action === "loaded") act(() => scrollFixture.latest.scrollToBottom())
  else if (action === "submit") h.stage({ items: [...h.input.items, message("local-keyboard", "me")], localSubmitVersion: 1 })
  else {
    let finish!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>(resolve => { finish = resolve })
    act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
    await act(async () => finish({ status: "success", window: next }))
    h.stage({ messageWindow: next, hasMoreNewer: false, items: [...h.input.items, message("requested-keyboard-tail")] })
  }
  scrollFixture.height += 60
  resize()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  expect(scrollFixture.latest.followingTail).toBe(true)
  h.update({ items: [...h.input.items, message("peer-after-keyboard-position")] })
  expect(h.root.querySelector('[data-msg-id="peer-after-keyboard-position"]')).not.toBeNull()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  scrollFixture.height += 120
  resize()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.followingTail).toBe(true)
})

it("lets real history input cancel a loaded-tail command waiting for the keyboard viewport", () => {
  const h = mount()
  h.move(300)
  scrollFixture.height -= 180
  act(() => scrollFixture.latest.scrollToBottom())
  fireEvent.wheel(h.root, { deltaY: -20 })
  resize()
  expect(h.root.scrollTop).toBe(300)
  expect(scrollFixture.latest.followingTail).toBe(false)
  h.update({ items: [...h.input.items, message("peer-after-keyboard-takeover")] })
  expect(h.root.scrollTop).toBe(300)
})

it.each(["loaded", "requested", "submit"] as const)("finishes %s when the keyboard-open tail grows after its native command landed", async action => {
  const previous = {}, next = {}
  scrollFixture.height -= 180
  const h = mount({ messageWindow: previous, hasMoreNewer: action === "requested" })
  h.move(300)
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  const actualBounds = bounds.getMockImplementation()!
  bounds.mockImplementation(function (this: HTMLElement) {
    return this.matches("[data-index]") ? DOMRect.fromRect() : actualBounds.call(this)
  })
  if (action === "loaded") act(() => scrollFixture.latest.scrollToBottom())
  else if (action === "submit") h.stage({ localSubmitVersion: 1 })
  else {
    let finish!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>(resolve => { finish = resolve })
    act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
    await act(async () => finish({ status: "success", window: next }))
    h.stage({ messageWindow: next, hasMoreNewer: false })
  }
  runFrames()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  bounds.mockImplementation(actualBounds)
  scrollFixture.bodyHeights.set("m13", 360)
  resize()
  expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
  expect(scrollFixture.latest.followingTail).toBe(true)
})

it.each([[false, 0], [true, 0], [false, 2], [false, 40], [false, 41], [false, 100], [false, 300]] as const)("keeps consecutive viewport shrinks aligned (reduced=%s, distance=%ipx)", (reduced, distance) => {
  reducedMotion(reduced)
  const h = mount()
  if (distance > 0) h.move(h.root.scrollHeight - h.root.clientHeight - distance)
  const before = h.root.scrollTop
  for (let frame = 0; frame < 3; frame++) {
    scrollFixture.height -= 20
    resize(2)
    if (distance <= CONVERSATION_TAIL_SPACE_PX) expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(distance)
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
