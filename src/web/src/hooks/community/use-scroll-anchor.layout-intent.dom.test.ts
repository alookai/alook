import { act, fireEvent } from "@/test/react-dom-harness"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flattenMessageItems } from "@/lib/community/message-list-items"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import type { Msg } from "@/lib/community/models/message"
import { bodyTop, installMessageScrollFixture, mount, resize, restoreMessageScrollFixture, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function messages(): Msg[] {
  return Array.from({ length: 50 }, (_, index) => ({
    id: `m${index}`, type: "chat", authorId: "peer", seq: index + 1,
    content: `Message ${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
  }))
}

it("keeps a short list at its CSS bottom with native physical coordinates through selection and footer changes", () => {
  const rows = flattenMessageItems(messages().slice(0, 1), undefined, false, false, true)
  const h = mount({ items: rows, positionEntry: {}, tailPaddingEnd: 32, viewportInsetEnd: 40 })
  try {
    const native = scrollFixture.latest.virtualizer
    const assertCoordinates = (tailGap: number) => {
      const body = h.root.querySelector<HTMLElement>('[data-msg-id="m0"]')!
      const wrapper = body.closest<HTMLElement>('[data-index]')!
      const row = native.getVirtualItems().find(item => item.index === rows.findIndex(item => item.kind === "message" && item.m.id === "m0"))!
      expect(native.options.paddingStart).toBe(0)
      expect(native.options.scrollMargin).toBeCloseTo(h.root.clientHeight - native.getTotalSize(), 1)
      expect(Math.abs(wrapper.getBoundingClientRect().top - h.root.getBoundingClientRect().top
        - h.root.clientTop + h.root.scrollTop - row.start)).toBeLessThanOrEqual(1)
      expect(Math.abs(h.root.clientHeight - body.getBoundingClientRect().bottom - tailGap)).toBeLessThanOrEqual(1)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
      const top = body.getBoundingClientRect().top
      runFrames()
      resize()
      expect(Math.abs(body.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
    }
    assertCoordinates(40)
    h.update({ tailPaddingEnd: 0, viewportInsetEnd: 0 })
    assertCoordinates(8)
    h.update({ tailPaddingEnd: 32, viewportInsetEnd: 40 })
    assertCoordinates(40)
    scrollFixture.height -= 80
    resize()
    assertCoordinates(40)
  } finally { h.view.unmount() }
})

function visibleBody(root: HTMLElement) {
  const body = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
    .find(element => element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < root.clientHeight)
  if (!body?.dataset.msgId) throw new Error("A visible message body is required")
  return { id: body.dataset.msgId, top: body.getBoundingClientRect().top }
}

function tailGeometry(h: ReturnType<typeof mount>, phase: string) {
  const native = scrollFixture.latest.virtualizer
  const body = h.root.querySelector<HTMLElement>('[data-msg-id="m30"]')
  return { phase, bodyTop: body?.getBoundingClientRect().top ?? null,
    scrollTop: h.root.scrollTop, scrollHeight: h.root.scrollHeight,
    clientHeight: h.root.clientHeight, clientWidth: h.root.clientWidth,
    tailDistance: h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop,
    nativeRootMatches: native.scrollElement === h.root,
    nativeWidth: native.scrollRect?.width ?? null, nativeHeight: native.scrollRect?.height ?? null,
    nativeOffset: native.scrollOffset ?? null, nativeScrolling: native.isScrolling, nativeAtEnd: native.isAtEnd(1),
    readReady: scrollFixture.latest.readPositionReady, followingTail: scrollFixture.latest.followingTail,
    paginationEnabled: scrollFixture.latest.paginationEnabled,
    paginationPending: scrollFixture.latest.paginationRequestPending,
    presentPending: scrollFixture.latest.presentPositionPending, localSubmitVersion: h.input.localSubmitVersion }
}

function qualifyRawTailAfterHistory(h: ReturnType<typeof mount>, rows: Msg[], projectNew: boolean) {
  const index = h.input.items.findIndex(item => item.kind === "message" && item.m.id === "m30")
  const item = h.input.items[index]
  const measured = scrollFixture.latest.virtualizer.measurementsCache[index]
  if (!item || item.kind !== "message" || !measured) throw new Error("Expected the measured historical message")
  h.move(measured.start + (item.paddingTop ?? 0))
  const body = bodyTop(h.root, "m30")
  const samples = [tailGeometry(h, "historical-before-New")]
  expect(scrollFixture.latest.followingTail).toBe(false)
  expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
  if (projectNew) {
    h.update({ items: flattenMessageItems(rows, "m30"), newDividerBefore: "m30" })
    samples.push(tailGeometry(h, "historical-after-New"))
    expect(h.root.querySelector('[data-message-divider-for="m30"] [data-new-divider]')).not.toBeNull()
    expect(Math.abs(bodyTop(h.root, "m30") - body), JSON.stringify(samples)).toBeLessThanOrEqual(1)
  }
  act(() => h.root.scrollTo({ top: h.root.scrollHeight - h.root.clientHeight }))
  runFrames()
  const native = scrollFixture.latest.virtualizer
  samples.push(tailGeometry(h, "settled-raw-tail"))
  const detail = JSON.stringify(samples)
  expect(native.scrollElement, detail).toBe(h.root)
  expect(native.scrollRect?.width, detail).toBe(h.root.clientWidth)
  expect(native.scrollRect?.height, detail).toBe(h.root.clientHeight)
  expect(native.isScrolling, detail).toBe(false)
  expect(native.scrollOffset, detail).toBeCloseTo(h.root.scrollTop, 1)
  expect(native.isAtEnd(1), detail).toBe(true)
  expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), detail).toBeLessThanOrEqual(1)
  expect(scrollFixture.latest.readPositionReady, detail).toBe(true)
  expect(scrollFixture.latest.paginationEnabled, detail).toBe(true)
  expect(scrollFixture.latest.paginationRequestPending, detail).toBe(false)
  expect(scrollFixture.latest.presentPositionPending, detail).toBe(false)
  expect(h.input.localSubmitVersion, detail).toBe(0)
  return samples
}

it.each([
  { distance: 60, height: 320 },
  { distance: 200, height: 800 },
])("keeps historical reading within available bounds through a viewport change to $height at tail distance $distance", ({ distance, height }) => {
  const h = mount({ items: flattenMessageItems(messages(), undefined), hasMoreOlder: false, positionEntry: {} })
  try {
    h.move(h.root.scrollHeight - h.root.clientHeight - distance)
    const body = visibleBody(h.root)
    expect(scrollFixture.latest.followingTail).toBe(false)
    const clampedShift = Math.max(0, height - 500 - distance)
    scrollFixture.height = height
    resize()
    expect(Math.abs(bodyTop(h.root, body.id) - body.top - clampedShift)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    scrollFixture.height = 500
    resize()
    expect(Math.abs(bodyTop(h.root, body.id) - body.top - clampedShift)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("keeps the qualified tail when late New inserts a real divider inside the visible suffix", () => {
  const rows = messages()
  const before = flattenMessageItems(rows, undefined)
  const after = flattenMessageItems(rows, "m48")
  expect(after.length).toBe(before.length + 1)
  expect(after.at(-1)?.key).toBe(before.at(-1)?.key)
  const h = mount({ items: before, hasMoreOlder: false, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const total = h.root.scrollHeight
    expect(scrollFixture.latest.followingTail).toBe(true)
    h.update({ items: after, newDividerBefore: "m48" })
    expect(h.root.querySelector('[data-message-divider-for="m48"] [data-new-divider]')).not.toBeNull()
    expect(h.root.scrollHeight).toBeGreaterThan(total)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("preserves the historical body when New changes its same-author grouping and padding", () => {
  const rows = messages()
  const before = flattenMessageItems(rows, undefined)
  const after = flattenMessageItems(rows, "m30")
  const prior = before.find(item => item.kind === "message" && item.m.id === "m30")!
  const next = after.find(item => item.kind === "message" && item.m.id === "m30")!
  expect(prior.kind === "message" && prior.m.grouped).toBe(true)
  expect(next.kind === "message" && next.m.grouped).toBe(false)
  const h = mount({ items: before, hasMoreOlder: false, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.indexOf(prior)
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + (prior.kind === "message" ? prior.paddingTop ?? 0 : 0))
    const top = bodyTop(h.root, "m30")
    expect(Math.abs(top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    h.update({ items: after, newDividerBefore: "m30" })
    expect(h.root.querySelector('[data-message-divider-for="m30"] [data-new-divider]')).not.toBeNull()
    expect(Math.abs(bodyTop(h.root, "m30") - top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("keeps the body through an actual same-count date-to-New key replacement", () => {
  const rows = messages().map((message, index) => index >= 30
    ? { ...message, createdAt: new Date(Date.UTC(2026, 0, 2, 12, index)).toISOString() } : message)
  const before = flattenMessageItems(rows, undefined)
  const after = flattenMessageItems(rows, "m30")
  expect(after.length).toBe(before.length)
  expect(before.find(item => item.kind === "divider" && item.messageId === "m30")?.key)
    .not.toBe(after.find(item => item.kind === "divider" && item.messageId === "m30")?.key)
  const h = mount({ items: before, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.findIndex(item => item.kind === "message" && item.m.id === "m30")
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + 8)
    const top = bodyTop(h.root, "m30")
    h.update({ items: after, newDividerBefore: "m30" })
    expect(h.root.querySelector('[data-message-divider-for="m30"] [data-new-divider]')).not.toBeNull()
    expect(Math.abs(bodyTop(h.root, "m30") - top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("preserves the body when a retired New projection rejoins the same-author group", () => {
  const rows = messages()
  const before = flattenMessageItems(rows, "m30")
  const h = mount({ items: before, newDividerBefore: "m30", positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.findIndex(item => item.kind === "message" && item.m.id === "m30")
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + 8)
    const top = bodyTop(h.root, "m30")
    h.update({ items: flattenMessageItems(rows, undefined), newDividerBefore: undefined })
    expect(h.root.querySelector('[data-new-divider]')).toBeNull()
    expect(Math.abs(bodyTop(h.root, "m30") - top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("retires a pending New body correction when wheel input takes ownership", () => {
  const rows = messages()
  const before = flattenMessageItems(rows, undefined)
  const h = mount({ items: before, positionEntry: {}, newBoundaryOwner: {} })
  try {
    h.move(3000)
    h.stage({ items: flattenMessageItems(rows, "m30"), newDividerBefore: "m30" })
    const pending = [...scrollFixture.frames.values()]
    fireEvent.wheel(h.root, { deltaY: 220 })
    act(() => h.root.scrollTo({ top: h.root.scrollTop + 220 }))
    resize()
    const body = visibleBody(h.root)
    act(() => { for (const frame of pending) frame(performance.now()) })
    runFrames()
    expect(Math.abs(bodyTop(h.root, body.id) - body.top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("does not take over released native scrolling when late New replaces a date row", () => {
  const rows = messages().map((message, index) => index >= 30
    ? { ...message, createdAt: new Date(Date.UTC(2026, 0, 2, 12, index)).toISOString() } : message)
  const before = flattenMessageItems(rows, undefined), after = flattenMessageItems(rows, "m30")
  expect(after.length).toBe(before.length)
  const h = mount({ items: before, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.findIndex(item => item.kind === "message" && item.m.id === "m30")
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + 8)
    fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    act(() => h.root.scrollTo({ top: h.root.scrollTop + 40 }))
    runFrames(1)
    fireEvent.touchEnd(h.root, { touches: [] })
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    const total = h.root.scrollHeight
    h.stage({ items: after, newDividerBefore: "m30" })
    expect(h.root.querySelector('[data-message-divider-for="m30"] [data-new-divider]')).not.toBeNull()
    expect(h.root.scrollHeight).toBe(total)
    const naturalOffset = h.root.scrollTop + 120
    act(() => h.root.scrollTo({ top: naturalOffset }))
    runFrames(1)
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(true)
    expect(h.root.scrollTop).toBe(naturalOffset)
    const body = visibleBody(h.root)
    runFrames()
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
    expect(h.root.scrollTop).toBe(naturalOffset)
    expect(Math.abs(bodyTop(h.root, body.id) - body.top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("retires a captured New viewport when native motion starts before correction", () => {
  const rows = messages().map((message, index) => index >= 30
    ? { ...message, createdAt: new Date(Date.UTC(2026, 0, 2, 12, index)).toISOString() } : message)
  const before = flattenMessageItems(rows, undefined), after = flattenMessageItems(rows, "m30")
  const h = mount({ items: before, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.findIndex(item => item.kind === "message" && item.m.id === "m30")
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + 8)
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
    const total = h.root.scrollHeight
    h.stage({ items: after, newDividerBefore: "m30" })
    expect(h.root.querySelector('[data-message-divider-for="m30"] [data-new-divider]')).not.toBeNull()
    expect(h.root.scrollHeight).toBe(total)
    const naturalOffset = h.root.scrollTop + 120
    act(() => h.root.scrollTo({ top: naturalOffset }))
    runFrames(1)
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(true)
    expect(h.root.scrollTop).toBe(naturalOffset)
    const body = visibleBody(h.root)
    runFrames()
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
    expect(h.root.scrollTop).toBe(naturalOffset)
    expect(Math.abs(bodyTop(h.root, body.id) - body.top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it("retires a New correction command when native motion leaves its applied position", () => {
  const rows = messages(), before = flattenMessageItems(rows, undefined)
  const h = mount({ items: before, positionEntry: {}, newBoundaryOwner: {} })
  try {
    const index = before.findIndex(item => item.kind === "message" && item.m.id === "m30")
    h.move(scrollFixture.latest.virtualizer.measurementsCache[index].start + 4)
    const native = scrollFixture.latest.virtualizer
    const writes = vi.spyOn(native, "scrollToOffset")
    h.stage({ items: flattenMessageItems(rows, "m30"), newDividerBefore: "m30" })
    for (let frame = 0; frame < 30 && writes.mock.calls.length === 0; frame++) resize(1)
    expect(writes.mock.calls.length).toBeGreaterThan(0)
    runFrames(1)
    expect(native.isScrolling).toBe(true)
    const naturalOffset = h.root.scrollTop + 120
    act(() => h.root.scrollTo({ top: naturalOffset }))
    runFrames(1)
    expect(native.isScrolling).toBe(true)
    expect(h.root.scrollTop).toBe(naturalOffset)
    const body = visibleBody(h.root)
    runFrames()
    expect(native.isScrolling).toBe(false)
    expect(h.root.scrollTop).toBe(naturalOffset)
    expect(Math.abs(bodyTop(h.root, body.id) - body.top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it.each(["bottom", "send"] as const)("restores tail following after a historical viewport hold through explicit %s", action => {
  const rows = messages()
  const h = mount({ items: flattenMessageItems(rows, undefined), positionEntry: {} })
  try {
    h.move(h.root.scrollHeight - h.root.clientHeight - 60)
    scrollFixture.height = 320
    resize()
    expect(scrollFixture.latest.followingTail).toBe(false)
    if (action === "bottom") { act(() => scrollFixture.latest.scrollToBottom()); runFrames() }
    else h.update({ localSubmitVersion: 1 })
    expect(scrollFixture.latest.followingTail).toBe(true)
    h.update({ items: flattenMessageItems([...rows, { ...rows.at(-1)!, id: "next", seq: 51 }], undefined) })
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})


it.each([false, true])("follows passive self append after a qualified raw tail arrival with New projection=%s", projectNew => {
  const rows = messages()
  const h = mount({ items: flattenMessageItems(rows, undefined), hasMoreOlder: false, hasMoreNewer: false,
    positionEntry: {}, newBoundaryOwner: {}, localSubmitVersion: 0,
    tailPaddingEnd: MESSAGE_RAIL_TAIL_PADDING_END_PX, viewportInsetEnd: 0 })
  try {
    const samples = qualifyRawTailAfterHistory(h, rows, projectNew)
    const height = h.root.scrollHeight
    const appended: Msg = { ...rows[rows.length - 1], id: "passive-self", seq: 51, authorId: "self",
      content: "Passive self append", createdAt: new Date(Date.UTC(2026, 0, 1, 12, 50)).toISOString() }
    h.update({ items: flattenMessageItems([...rows, appended], projectNew ? "m30" : undefined) })
    samples.push(tailGeometry(h, "passive-self-append"))
    expect(h.input.localSubmitVersion).toBe(0)
    expect(h.root.scrollHeight).toBeGreaterThan(height)
    expect(h.root.querySelector('[data-msg-id="passive-self"]')).not.toBeNull()
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it.each([false, true])("keeps exact tail through in-flow composer shrink and grow after a raw tail arrival with New projection=%s", projectNew => {
  const rows = messages()
  const h = mount({ items: flattenMessageItems(rows, undefined), hasMoreOlder: false, hasMoreNewer: false,
    positionEntry: {}, newBoundaryOwner: {}, localSubmitVersion: 0,
    tailPaddingEnd: MESSAGE_RAIL_TAIL_PADDING_END_PX, viewportInsetEnd: 40 })
  try {
    const samples = qualifyRawTailAfterHistory(h, rows, projectNew)
    const initialHeight = h.root.scrollHeight, viewportHeight = h.root.clientHeight
    scrollFixture.height = viewportHeight - 168
    resize()
    samples.push(tailGeometry(h, "first-composer-growth"))
    expect(h.root.clientHeight).toBe(viewportHeight - 168)
    expect(h.root.scrollHeight).toBe(initialHeight)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    scrollFixture.height = viewportHeight
    resize()
    samples.push(tailGeometry(h, "composer-shrink"))
    expect(h.root.clientHeight).toBe(viewportHeight)
    expect(h.root.scrollHeight).toBe(initialHeight)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    scrollFixture.height = viewportHeight - 168
    resize()
    samples.push(tailGeometry(h, "composer-regrowth"))
    expect(h.root.clientHeight).toBe(viewportHeight - 168)
    expect(h.root.scrollHeight).toBe(initialHeight)
    expect(scrollFixture.latest.virtualizer.options.paddingEnd).toBe(MESSAGE_RAIL_TAIL_PADDING_END_PX)
    expect(scrollFixture.latest.virtualizer.options.scrollPaddingEnd).toBe(40)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})


it.each([0, 1])("does not let New's own layout compensation restore following after upward takeover at %spx", distance => {
  const rows = messages()
  const h = mount({ items: flattenMessageItems(rows, undefined), hasMoreOlder: false, hasMoreNewer: false,
    positionEntry: {}, newBoundaryOwner: {}, localSubmitVersion: 0 })
  try {
    h.move(h.root.scrollHeight - h.root.clientHeight - distance)
    fireEvent.wheel(h.root, { deltaY: -20 })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop - distance)).toBeLessThanOrEqual(1)
    const body = visibleBody(h.root), beforeOffset = h.root.scrollTop
    const sample = (phase: string) => ({ ...tailGeometry(h, phase), heldMessage: body.id, heldTop: bodyTop(h.root, body.id) })
    const samples = [sample("upward-takeover-before-New")]
    h.update({ items: flattenMessageItems(rows, "m40"), newDividerBefore: "m40" })
    samples.push(sample("own-New-compensation-settled"))
    expect(h.root.querySelector('[data-message-divider-for="m40"] [data-new-divider]')).not.toBeNull()
    expect(h.root.scrollTop, JSON.stringify(samples)).toBeGreaterThan(beforeOffset + 1)
    expect(Math.abs(bodyTop(h.root, body.id) - body.top), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    expect(Math.abs(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
    const compensatedOffset = h.root.scrollTop
    act(() => h.root.scrollTo({ top: compensatedOffset }))
    runFrames()
    samples.push(sample("same-offset-scroll-after-compensation"))
    expect(scrollFixture.latest.followingTail, JSON.stringify(samples)).toBe(false)
    const appended: Msg = { ...rows[rows.length - 1], id: "held-passive-self", seq: 51, authorId: "self",
      content: "Passive self append after takeover", createdAt: new Date(Date.UTC(2026, 0, 1, 12, 50)).toISOString() }
    h.update({ items: flattenMessageItems([...rows, appended], "m40") })
    samples.push(sample("passive-append-after-own-compensation"))
    expect(h.input.localSubmitVersion).toBe(0)
    expect(h.root.scrollTop, JSON.stringify(samples)).toBeCloseTo(compensatedOffset, 1)
    expect(Math.abs(bodyTop(h.root, body.id) - body.top), JSON.stringify(samples)).toBeLessThanOrEqual(1)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeGreaterThan(1)
    expect(scrollFixture.latest.followingTail, JSON.stringify(samples)).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})
