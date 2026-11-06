import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageRequest, MessageRequestResult, NewPositionRequest, NewPositionResult } from "@/lib/community/message-position"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import { CONVERSATION_READ_TIMEOUT_MS } from "@/lib/community/conversation-read"
import type { useScrollAnchor } from "./use-scroll-anchor"

type BoundaryReached = NonNullable<Parameters<typeof useScrollAnchor>[0]["onNewBoundaryReached"]>

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function start(id: string, load?: () => MessageRequest) {
  let request!: NewPositionRequest
  act(() => { request = scrollFixture.latest.requestNewPosition(id, load) })
  if (!request.accepted) throw new Error("New positioning was not accepted")
  return request
}
const items = () => Array.from({ length: 50 }, (_, index) => ({ ...message(`m${index}`), newDivider: index === 5 }))

it.each(["explicit", "present"] as const)("revokes manual arrival qualification when %s takes positioning and settles", action => {
  const reached = vi.fn<BoundaryReached>(), entry = {}, owner = {}
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49", initialPositionMessageId: "m0", positionEntry: entry,
    newBoundaryOwner: owner, onNewBoundaryReached: reached })
  try {
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    h.move(100)
    expect(reached).not.toHaveBeenCalled()
    act(() => { if (action === "explicit") scrollFixture.latest.jumpTo("m49", "auto"); else scrollFixture.latest.scrollToBottom() })
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(reached).not.toHaveBeenCalled()
    h.move(h.root.scrollTop - 1)
    expect(reached.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ id: "m49", entry, owner }))
    expect(reached.mock.calls.at(-1)?.[0].entry).toBe(entry)
    expect(reached.mock.calls.at(-1)?.[0].owner).toBe(owner)
  } finally { h.view.unmount() }
})

it("keeps manual arrival eligible through same-owner image and composer measurements", () => {
  const reached = vi.fn<BoundaryReached>(), entry = {}, owner = {}
  const h = mount({ items: items(), newDividerBefore: "m5", initialPositionMessageId: "m0", positionEntry: entry,
    newBoundaryOwner: owner, onNewBoundaryReached: reached })
  try {
    h.move(100)
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    h.move(h.root.scrollTop + divider.getBoundingClientRect().top - 100)
    const first = reached.mock.calls.at(-1)?.[0]
    expect(first).toEqual(expect.objectContaining({ id: "m5", entry, owner }))
    expect(first?.entry).toBe(entry)
    expect(first?.owner).toBe(owner)
    reached.mockClear()
    scrollFixture.bodyHeights.set("m4", 250)
    resize()
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(reached.mock.calls.at(-1)?.[0]).toEqual(first)
    h.update({ viewportInsetEnd: 450 })
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    reached.mockClear()
    h.update({ viewportInsetEnd: 0 })
    expect(reached.mock.calls.at(-1)?.[0]).toEqual(first)
  } finally { h.view.unmount() }
})

it("does not inherit a manual qualification after inactivity or a recipient change", () => {
  const reached = vi.fn<BoundaryReached>()
  const h = mount({ items: items(), newDividerBefore: "m5", initialPositionMessageId: "m0", positionEntry: {},
    newBoundaryOwner: {}, onNewBoundaryReached: reached })
  try {
    h.move(1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    expect(reached).not.toHaveBeenCalled()
    h.update({ active: false, positioningActive: true })
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    act(() => h.root.scrollTo({ top: h.root.scrollTop + divider.getBoundingClientRect().top - 100 }))
    resize()
    h.update({ active: true })
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(reached).not.toHaveBeenCalled()
    h.move(h.root.scrollTop + 1)
    expect(reached).toHaveBeenCalled()
    reached.mockClear()
    h.update({ newBoundaryOwner: {} })
    expect(reached).not.toHaveBeenCalled()
    h.move(h.root.scrollTop + 1)
    expect(reached).toHaveBeenCalled()
  } finally { h.view.unmount() }
})

it.each(["pending", "error"] as const)("does not notify from a child row commit after data becomes %s", state => {
  const reached = vi.fn<BoundaryReached>()
  const h = mount({ items: items(), newDividerBefore: "m5", initialPositionMessageId: "m0", positionEntry: {},
    newBoundaryOwner: {}, onNewBoundaryReached: reached })
  try {
    h.move(1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    h.move(h.root.scrollTop + divider.getBoundingClientRect().top - 100)
    expect(reached).toHaveBeenCalled()
    reached.mockClear()
    h.update({ positionDataState: state })
    expect(reached).not.toHaveBeenCalled()
  } finally { h.view.unmount() }
})

it("enters at the real bottom and keeps late New metadata from taking scroll ownership", () => {
  const h = mount({ items: items(), newDividerBefore: "m5" })
  try {
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("above")
    h.update({ newDividerBefore: undefined })
    h.update({ newDividerBefore: "m5" })
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("keeps New below the readable viewport while its divider is covered by the composer", () => {
  const h = mount({ items: items(), newDividerBefore: "m5", viewportInsetEnd: 100 })
  try {
    h.move(100)
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    h.move(h.root.scrollTop + divider.getBoundingClientRect().top - 450)
    expect(divider.getBoundingClientRect().top).toBe(450)
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    h.update({ viewportInsetEnd: 0 })
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
  } finally { h.view.unmount() }
})

it.each([5, 49])("finishes at the measured New boundary within natural content bounds, target index=%s", async target => {
  const id = `m${target}`
  const rows = items().map((item, index) => ({ ...item, newDivider: index === target }))
  const h = mount({ items: rows, newDividerBefore: id })
  try {
    h.move(100)
    let outcome: NewPositionResult | undefined
    const request = start(id)
    void request.completed.then(result => { outcome = result })
    resize()
    await act(async () => {})
    expect(outcome).toBe("success")
    const divider = h.root.querySelector<HTMLElement>(`[data-message-divider-for="${id}"] [data-new-divider]`)!
    const top = divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top
    const naturalDestination = Math.max(0, Math.min(h.root.scrollHeight - h.root.clientHeight, h.root.scrollTop + top))
    expect(Math.abs(h.root.scrollTop - naturalDestination)).toBeLessThanOrEqual(1)
    if (target === 5) expect(Math.abs(top)).toBeLessThanOrEqual(1)
    else expect(top).toBeGreaterThan(1)
    expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.followingTail).toBe(false)
    h.update({ items: [...rows, message("arrived-after-New")] })
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("waits for the exact main window and committed target rows after accepting a load", async () => {
  const h = mount({ items: Array.from({ length: 50 }, (_, index) => message(`tail${index}`)), newDividerBefore: "m5" })
  let complete!: (result: MessageRequestResult) => void
  const loaded = new Promise<MessageRequestResult>(resolve => { complete = resolve })
  try {
    let outcome: NewPositionResult | undefined
    const request = start("m5", () => ({ accepted: true, completed: loaded }))
    void request.completed.then(result => { outcome = result })
    resize()
    expect(outcome).toBeUndefined()
    const window = {}
    await act(async () => { complete({ status: "success", window }) })
    resize()
    expect(outcome).toBeUndefined()
    h.update({ items: items(), messageWindow: window })
    await act(async () => {})
    expect(outcome).toBe("success")
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
  } finally { h.view.unmount() }
})

it("cancels the data selection and ignores late completion after the user takes over", async () => {
  const h = mount({ items: Array.from({ length: 50 }, (_, index) => message(`tail${index}`)), newDividerBefore: "m5" })
  let complete!: (result: MessageRequestResult) => void
  const loaded = new Promise<MessageRequestResult>(resolve => { complete = resolve }), cancel = vi.fn()
  try {
    const request = start("m5", () => ({ accepted: true, completed: loaded, cancel }))
    h.move(h.root.scrollTop - 80)
    expect(await request.completed).toBe("cancelled")
    expect(cancel).toHaveBeenCalledOnce()
    const reader = h.root.scrollTop
    await act(async () => { complete({ status: "success", window: {} }) })
    resize()
    expect(h.root.scrollTop).toBe(reader)
  } finally { h.view.unmount() }
})

it("keeps data and layout failures retryable instead of consuming an issued scroll", async () => {
  const h = mount({ items: items(), newDividerBefore: "m5" })
  try {
    const failed = start("m5", () => ({ accepted: true, completed: Promise.resolve({ status: "error" }) }))
    await act(async () => {})
    expect(await failed.completed).toBe("error")
    resize()
    scrollFixture.height = 0
    h.update({})
    const unpositioned = start("m5")
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS) })
    expect(await unpositioned.completed).toBe("error")
    scrollFixture.height = 500
    resize()
    let outcome: NewPositionResult | undefined
    const retry = start("m5")
    void retry.completed.then(result => { outcome = result })
    resize()
    await act(async () => {})
    expect(outcome).toBe("success")
  } finally { h.view.unmount() }
})

it("keeps short-suffix New reading inside natural bounds through viewport size changes", async () => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    const naturalHeight = h.root.scrollHeight
    for (const height of [680, 320, 500]) {
      const priorOffset = h.root.scrollTop
      scrollFixture.height = height
      resize()
      const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m49"] [data-new-divider]')!
      expect(h.root.scrollTop).toBe(Math.min(priorOffset, naturalHeight - height))
      expect(scrollFixture.latest.newDividerVisibility).toBe(divider.getBoundingClientRect().top >= height ? "below" : "visible")
      expect(h.root.scrollHeight).toBe(naturalHeight)
      expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
      expect(scrollFixture.latest.followingTail).toBe(false)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
    }
  } finally { h.view.unmount() }
})

it("preserves New reading across append and viewport growth without manufacturing suffix space", async () => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    const naturalHeight = h.root.scrollHeight
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m49"] [data-new-divider]')!
    const top = divider.getBoundingClientRect().top
    h.update({ items: [...rows, ...Array.from({ length: 4 }, (_, index) => message(`later${index}`))] })
    expect(h.root.scrollHeight).toBe(naturalHeight + 400)
    expect(Math.abs(divider.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
    scrollFixture.height = 680
    resize()
    expect(h.root.scrollHeight).toBe(naturalHeight + 400)
    expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it.each(["explicit", "present"] as const)("lets %s take ownership after a bounded New jump without changing content extent", async action => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    const naturalHeight = h.root.scrollHeight
    if (action === "explicit") h.update({ scrollToMessageId: "m49" })
    else act(() => scrollFixture.latest.scrollToBottom())
    resize()
    expect(h.root.scrollHeight).toBe(naturalHeight)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  } finally { h.view.unmount() }
})

it("reports mounted and virtualized boundaries above, inside and below the viewport", () => {
  const h = mount({ items: items(), newDividerBefore: "m5" })
  try {
    expect(h.root.querySelector('[data-new-divider]')).toBeNull()
    expect(scrollFixture.latest.newDividerVisibility).toBe("above")
    h.move(0)
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    const divider = h.root.querySelector<HTMLElement>('[data-new-divider]')!
    const boundaryOffset = h.root.scrollTop + divider.getBoundingClientRect().top
    h.move(boundaryOffset - h.root.clientHeight + 1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    h.move(boundaryOffset + divider.getBoundingClientRect().height)
    expect(scrollFixture.latest.newDividerVisibility).toBe("above")
    h.update({ items: items().map((item, index) => ({ ...item, newDivider: index === 45 })), newDividerBefore: "m45" })
    h.move(0)
    expect(h.root.querySelector('[data-new-divider]')).toBeNull()
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
  } finally { h.view.unmount() }
})

it.each([
  { seq: 1, expected: "above" },
  { seq: 99, expected: "below" },
  { seq: 25, expected: "pending" },
  { seq: undefined, expected: "pending" },
])("keeps an unloaded boundary direction honest: $seq -> $expected", ({ seq, expected }) => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...message(`loaded${index}`), m: { ...message(`loaded${index}`).m, seq: 20 + index } }))
  const h = mount({ items: rows, newDividerBefore: "unloaded", newDividerSeq: seq })
  try {
    expect(scrollFixture.latest.newDividerVisibility).toBe(expected)
    h.update({ positionDataState: "pending" })
    expect(scrollFixture.latest.newDividerVisibility).toBe("pending")
    h.update({ positionDataState: "ready", active: false })
    expect(scrollFixture.latest.newDividerVisibility).toBe("pending")
  } finally { h.view.unmount() }
})

it.each([1, 3])("does not create blank tail space for a whole short conversation of %s messages", async count => {
  const rows = Array.from({ length: count }, (_, index) => ({ ...message(`m${index}`), newDivider: index === 0 }))
  const h = mount({ items: rows, newDividerBefore: "m0", hasMoreOlder: false })
  try {
    const height = h.root.scrollHeight
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    const request = start("m0")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    expect(h.root.scrollHeight).toBe(height)
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("handles late image-size growth during a bounded New load without extra tail padding", async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ ...message(`m${index}`), newDivider: index === 7 }))
  const h = mount({ items: rows, newDividerBefore: "m7" })
  let complete!: (result: MessageRequestResult) => void
  try {
    const request = start("m7", () => ({ accepted: true, completed: new Promise(resolve => { complete = resolve }) }))
    const priorHeight = h.root.scrollHeight
    scrollFixture.bodyHeights.set("m6", 350)
    resize()
    const window = {}
    await act(async () => complete({ status: "success", window }))
    h.update({ messageWindow: window })
    expect(await request.completed).toBe("success")
    expect(h.root.scrollHeight).toBe(priorHeight + 250)
    const divider = h.root.querySelector<HTMLElement>('[data-new-divider]')!
    expect(divider.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(divider.getBoundingClientRect().bottom).toBeLessThanOrEqual(h.root.clientHeight)
    expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("accepts a resize clamp while New's native scroll settles before the reader moves and a peer appends", async () => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 45 }))
  const h = mount({ items: rows, newDividerBefore: "m45", tailPaddingEnd: 92, viewportInsetEnd: 52 })
  try {
    const request = start("m45")
    let outcome: NewPositionResult | undefined
    void request.completed.then(result => { outcome = result })
    resize(3)
    await act(async () => {})
    expect(outcome).toBe("success")
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(true)
    scrollFixture.height = 900
    resize(1)
    const max = h.root.scrollHeight - h.root.clientHeight
    expect(h.root.scrollTop).toBe(max)
    act(() => {
      h.root.scrollTop = max - 20
      h.root.dispatchEvent(new Event("scroll"))
    })
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m45"] [data-new-divider]')!
    const before = divider.getBoundingClientRect().top
    h.update({ items: [...rows, message("peer-after-resize")] })
    expect(Math.abs(divider.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1)
    expect(h.root.scrollTop).toBe(max - 20)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})
