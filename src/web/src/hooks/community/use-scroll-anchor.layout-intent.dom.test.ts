import { act, fireEvent } from "@/test/react-dom-harness"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flattenMessageItems } from "@/lib/community/message-list-items"
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

function visibleBody(root: HTMLElement) {
  const body = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
    .find(element => element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < root.clientHeight)
  if (!body?.dataset.msgId) throw new Error("A visible message body is required")
  return { id: body.dataset.msgId, top: body.getBoundingClientRect().top }
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
