import type { MessageRequestResult } from "@/lib/community/message-position"
import { createElement, useCallback } from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

const commitGate = vi.hoisted(() => ({ hold: false, publish: undefined as (() => void) | undefined }))
vi.mock("@/components/community/messages/virtual-cursor-list", async original => {
  const actual = await original<typeof import("@/components/community/messages/virtual-cursor-list")>()
  return { ...actual, VirtualRows: function HeldCommitRows(props: Parameters<typeof actual.VirtualRows>[0]) {
    const { onLayoutCommit } = props
    const commit = useCallback<NonNullable<typeof props.onLayoutCommit>>(layout => {
      if (commitGate.hold && layout) commitGate.publish = () => onLayoutCommit?.(layout)
      else onLayoutCommit?.(layout)
    }, [onLayoutCommit])
    return createElement(actual.VirtualRows, { ...props, onLayoutCommit: commit })
  } }
})

beforeEach(() => { commitGate.hold = false; commitGate.publish = undefined })
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

describe("manual reading waits for the real matching row commit", () => {
  function pendingReader() {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    reading.mockClear()
    commitGate.hold = true
    fireEvent.wheel(h.root, { deltaY: -800 })
    act(() => h.root.scrollTo({ top: 0 }))
    runFrames(1)
    expect(commitGate.publish).toBeDefined()
    expect(reading).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    return { h, reading }
  }
  function publishRows() {
    const publish = commitGate.publish
    if (!publish) throw new Error("An actual held row-layout callback is required")
    commitGate.hold = false
    act(() => publish())
  }
  function actualReadingBody(root: HTMLElement) {
    const viewport = root.getBoundingClientRect()
    return Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(body => {
      const rect = body.getBoundingClientRect()
      return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
    })?.dataset.msgId
  }
  function acceptedReader() {
    const result = pendingReader()
    publishRows()
    runFrames(40)
    expect(result.reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(result.h.root))
    expect(scrollFixture.frames.size).toBe(0)
    return result
  }
  it.each([false, true])("retains the actual automatic report through passive replacement=%s before the first manual displacement", replace => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), initialPositionMessageId: "m0", onReadingMessage: reading })
    try {
      const reported = actualReadingBody(h.root)
      expect(reported).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(reported)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
      if (replace) {
        commitGate.hold = true
        h.stage({ items: h.input.items.filter(item => item.kind !== "message" || item.m.id !== reported), messageWindow: {} })
        resize(0)
        publishRows()
        resize(40)
      }
      const baseline = { id: actualReadingBody(h.root), offset: h.root.scrollTop }
      expect(baseline.id).toBeDefined()
      if (replace) expect(baseline.id).not.toBe(reported)
      else expect(baseline.id).toBe(reported)
      expect(reading).toHaveBeenCalledOnce()
      fireEvent.wheel(h.root, { deltaY: 15 })
      act(() => h.root.scrollTo({ top: baseline.offset + 15 }))
      resize(40)
      expect(h.root.scrollTop).toBe(baseline.offset + 15)
      expect(actualReadingBody(h.root)).toBe(baseline.id)
      expect(reading).toHaveBeenCalledTimes(replace ? 2 : 1)
      expect(reading).toHaveBeenLastCalledWith(replace ? baseline.id : reported)
      resize(40)
      expect(reading).toHaveBeenCalledTimes(replace ? 2 : 1)
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["window", "items", "both", "viewport", "padding"] as const)("renews a consumed reading baseline after passive %s commit without creating credit", scope => {
    const { h, reading } = acceptedReader()
    try {
      const before = { offset: h.root.scrollTop, id: actualReadingBody(h.root) }
      commitGate.hold = true
      if (scope === "viewport") { scrollFixture.height = 620; scrollFixture.width = 400 }
      else if (scope === "padding") h.stage({ tailPaddingEnd: 80 })
      else h.stage({ ...(scope !== "items" ? { messageWindow: {} } : {}), ...(scope !== "window" ? { items: [...h.input.items] } : {}) })
      resize(0)
      runFrames(40)
      expect(reading).toHaveBeenCalledOnce()
      publishRows()
      resize(40)
      expect(h.root.scrollTop).toBe(before.offset)
      expect(actualReadingBody(h.root)).toBe(before.id)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      const current = actualReadingBody(h.root)
      expect(current).toBeDefined()
      expect(current).not.toBe(before.id)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(current)
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each([false, true])("reports a passively replaced body on its next real displacement with fresh intent=%s", fresh => {
    const { h, reading } = acceptedReader()
    try {
      const previous = actualReadingBody(h.root)
      commitGate.hold = true
      h.stage({ items: h.input.items.filter(item => item.kind !== "message" || item.m.id !== previous), messageWindow: {} })
      resize(0)
      publishRows()
      resize(40)
      const current = actualReadingBody(h.root)
      expect(current).toBeDefined()
      expect(current).not.toBe(previous)
      expect(h.root.scrollTop).toBe(0)
      expect(reading).toHaveBeenCalledOnce()
      if (fresh) fireEvent.wheel(h.root, { deltaY: 30 })
      act(() => h.root.scrollTo({ top: 30 }))
      resize(40)
      expect(h.root.scrollTop).toBe(30)
      expect(actualReadingBody(h.root)).toBe(current)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(current)
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("does not sample away an earlier-frame displacement before native scroll delivery", () => {
    const { h, reading } = acceptedReader()
    try {
      const publish = commitGate.publish!
      const before = h.root.scrollTop
      act(() => {
        window.requestAnimationFrame(() => h.root.scrollTo({ top: 350 }))
        publish()
      })
      runFrames(1)
      expect(h.root.scrollTop).toBe(350)
      expect(h.root.scrollTop).not.toBe(before)
      expect(reading).toHaveBeenCalledOnce()
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("renews a consumed baseline only after current data becomes ready", () => {
    const { h, reading } = acceptedReader()
    try {
      commitGate.hold = true
      h.stage({ positionDataState: "pending", items: [...h.input.items], messageWindow: {} })
      publishRows()
      resize(40)
      expect(reading).toHaveBeenCalledOnce()
      h.update({ positionDataState: "ready" })
      expect(reading).toHaveBeenCalledOnce()
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["entry", "hidden"] as const)("does not renew consumed manual credit into a new %s owner", retirement => {
    const { h, reading } = acceptedReader()
    try {
      if (retirement === "entry") h.stage({ positionEntry: {}, items: [...h.input.items], messageWindow: {} })
      else { h.stage({ active: false }); h.stage({ active: true, items: [...h.input.items], messageWindow: {} }) }
      resize(40)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
      const afterAutomaticReading = reading.mock.calls.length
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(afterAutomaticReading)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 900 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(afterAutomaticReading + 1)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("does not revive a consumed baseline from a row callback after unmount", () => {
    const { h, reading } = acceptedReader()
    commitGate.hold = true
    h.stage({ items: [...h.input.items], messageWindow: {} })
    const publish = commitGate.publish!
    h.view.unmount()
    commitGate.hold = false
    act(() => publish())
    resize(40)
    expect(reading).toHaveBeenCalledOnce()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["window", "items", "both"] as const)("hands off a consumed %s baseline at commit before native scroll without creating a callback", scope => {
    const { h, reading } = acceptedReader()
    let nativeEvents = 0
    const record = () => { nativeEvents += 1 }
    h.root.addEventListener("scroll", record)
    try {
      const height = h.root.scrollHeight
      commitGate.hold = true
      h.stage({ ...(scope !== "items" ? { messageWindow: {} } : {}), ...(scope !== "window" ? { items: [...h.input.items] } : {}) })
      act(() => h.root.scrollTo({ top: 350 }))
      expect(h.root.scrollTop).toBe(350)
      expect(nativeEvents).toBe(0)
      publishRows()
      expect(nativeEvents).toBe(0)
      expect(h.root.scrollHeight).toBe(height)
      expect(reading).toHaveBeenCalledOnce()
      resize(40)
      expect(nativeEvents).toBe(1)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      expect(scrollFixture.frames.size).toBe(0)
    } finally { h.root.removeEventListener("scroll", record); commitGate.hold = false; h.view.unmount() }
  })
  it.each(["above", "below"] as const)("keeps a consumed baseline passive through %s-fold native measurement and changed refs", location => {
    const { h, reading } = acceptedReader()
    try {
      act(() => h.root.scrollTo({ top: 600 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      const native = scrollFixture.latest.virtualizer
      const id = actualReadingBody(h.root)!
      const before = { offset: h.root.scrollTop, body: bodyTop(h.root, id) }
      const row = native.getVirtualItems().find(row => String(row.key).startsWith("msg:")
        && (location === "above" ? row.end <= h.root.scrollTop : row.start > h.root.scrollTop + h.root.clientHeight))
      if (!row) throw new Error("An actual measured row is required")
      commitGate.hold = true
      h.stage({ items: [...h.input.items], messageWindow: {} })
      scrollFixture.bodyHeights.set(String(row.key).slice(4), row.size + 80)
      act(() => native.resizeItem(row.index, row.size + 80))
      expect(h.root.scrollTop).toBe(location === "above" ? before.offset + 80 : before.offset)
      expect(native.scrollOffset).toBe(h.root.scrollTop)
      publishRows()
      expect(reading).toHaveBeenCalledTimes(2)
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(actualReadingBody(h.root)).toBe(id)
      expect(bodyTop(h.root, id)).toBe(before.body)
      act(() => h.root.scrollTo({ top: h.root.scrollTop + 350 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(3)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("keeps viewport clamping with changed refs passive before the next genuine movement", () => {
    const { h, reading } = acceptedReader()
    try {
      act(() => h.root.scrollTo({ top: 600 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      const before = { offset: h.root.scrollTop, height: h.root.clientHeight }
      commitGate.hold = true
      scrollFixture.height = h.root.scrollHeight * 2
      h.stage({ items: [...h.input.items], messageWindow: {} })
      resize(0)
      publishRows()
      resize(40)
      expect(h.root.scrollTop).toBe(0)
      expect(h.root.scrollTop).toBeLessThan(before.offset)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
      scrollFixture.height = before.height
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      act(() => h.root.scrollTo({ top: 350 }))
      resize(40)
      expect(h.root.scrollTop).toBe(350)
      expect(reading).toHaveBeenCalledTimes(3)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["items", "both"] as const)("qualifies the committed origin for a far consumed %s movement with no current old body", scope => {
    const { h, reading } = acceptedReader()
    let nativeEvents = 0
    const record = () => { nativeEvents += 1 }
    h.root.addEventListener("scroll", record)
    try {
      commitGate.hold = true
      h.stage({ items: [...h.input.items], ...(scope === "both" ? { messageWindow: {} } : {}) })
      act(() => h.root.scrollTo({ top: 3500 }))
      expect(h.root.scrollTop).toBe(3500)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeGreaterThan(h.root.clientHeight)
      expect(actualReadingBody(h.root)).toBeUndefined()
      expect(nativeEvents).toBe(0)
      publishRows()
      expect(actualReadingBody(h.root)).toBeUndefined()
      expect(nativeEvents).toBe(0)
      expect(reading).toHaveBeenCalledOnce()
      resize(40)
      expect(nativeEvents).toBe(1)
      const current = actualReadingBody(h.root)
      expect(current).toBeDefined()
      expect(current).not.toBe("m0")
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(current)
      expect(scrollFixture.frames.size).toBe(0)
    } finally { h.root.removeEventListener("scroll", record); commitGate.hold = false; h.view.unmount() }
  })
  it("does not convert an unqualified native event before the new commit into reading credit", () => {
    const { h, reading } = acceptedReader()
    try {
      commitGate.hold = true
      h.stage({ items: [...h.input.items], messageWindow: {} })
      act(() => h.root.scrollTo({ top: 3500 }))
      runFrames(1)
      expect(h.root.scrollTop).toBe(3500)
      expect(reading).toHaveBeenCalledOnce()
      publishRows()
      resize(40)
      expect(actualReadingBody(h.root)).toBeDefined()
      expect(reading).toHaveBeenCalledOnce()
      act(() => h.root.scrollTo({ top: 3530 }))
      resize(40)
      expect(h.root.scrollTop).toBe(3530)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  function movedBeforeWheelReader(offset = 0) {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    h.move(600)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    reading.mockClear()
    commitGate.hold = true
    act(() => h.root.scrollTo({ top: offset }))
    expect(h.root.scrollTop).toBe(offset)
    fireEvent.wheel(h.root, { deltaY: offset - 600 })
    runFrames(1)
    expect(commitGate.publish).toBeDefined()
    expect(reading).not.toHaveBeenCalled()
    return { h, reading }
  }
  it.each([[0, "m0"], [350, "m2"]] as const)("reports the first reading at %s when root moves before wheel samples the input", (offset, id) => {
    const { h, reading } = movedBeforeWheelReader(offset)
    try {
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      publishRows()
      runFrames(2)
      expect(actualReadingBody(h.root)).toBe(id)
      expect(reading).toHaveBeenCalledExactlyOnceWith(id)
      runFrames(40)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("does not report wheel intent followed by a same-position scroll", () => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    h.move(600)
    const before = { offset: h.root.scrollTop, id: actualReadingBody(h.root) }
    reading.mockClear()
    fireEvent.wheel(h.root, { deltaY: -600 })
    fireEvent.scroll(h.root)
    resize(40)
    expect(h.root.scrollTop).toBe(before.offset)
    expect(actualReadingBody(h.root)).toBe(before.id)
    expect(reading).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["above", "below"] as const)("does not borrow a movement from passive %s-fold measurement before wheel intent", location => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    h.move(600)
    reading.mockClear()
    const native = scrollFixture.latest.virtualizer
    const row = native.getVirtualItems().find(row => String(row.key).startsWith("msg:")
      && (location === "above" ? row.end <= h.root.scrollTop : row.start > h.root.scrollTop + h.root.clientHeight))
    if (!row) throw new Error("An actual measured row is required")
    const id = actualReadingBody(h.root)!
    const before = { offset: h.root.scrollTop, body: bodyTop(h.root, id), total: native.getTotalSize() }
    commitGate.hold = true
    scrollFixture.bodyHeights.set(String(row.key).slice(4), row.size + 80)
    act(() => native.resizeItem(row.index, row.size + 80))
    expect(native.getTotalSize()).toBeGreaterThan(before.total)
    expect(h.root.scrollTop).toBe(location === "above" ? before.offset + 80 : before.offset)
    fireEvent.wheel(h.root, { deltaY: -600 })
    resize(0)
    publishRows()
    runFrames(40)
    expect(bodyTop(h.root, id)).toBe(before.body)
    expect(actualReadingBody(h.root)).toBe(id)
    expect(reading).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["entry", "window", "items"] as const)("does not reuse the old %s baseline when movement precedes input", scope => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), messageWindow: {}, onReadingMessage: reading })
    h.move(600)
    reading.mockClear()
    commitGate.hold = true
    if (scope === "entry") h.stage({ positionEntry: {} })
    else if (scope === "window") h.stage({ messageWindow: {} })
    else h.stage({ items: [...h.input.items] })
    act(() => h.root.scrollTo({ top: 0 }))
    fireEvent.wheel(h.root, { deltaY: -600 })
    runFrames(1)
    publishRows()
    runFrames(40)
    expect(h.root.scrollTop).toBe(0)
    expect(reading).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["target", "present", "hidden"] as const)("retires movement sampled after displacement through %s", async retirement => {
    const { h, reading } = movedBeforeWheelReader()
    let finishPresent: ((result: MessageRequestResult) => void) | undefined
    try {
      if (retirement === "target") h.stage({ scrollToMessageId: "m20" })
      else if (retirement === "present") {
        const completed = new Promise<MessageRequestResult>(resolve => { finishPresent = resolve })
        act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
      }
      else { h.stage({ active: false }); h.stage({ active: true }) }
      fireEvent.wheel(h.root, { deltaY: -800 })
      publishRows()
      runFrames(40)
      expect(h.root.scrollTop).toBe(0)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(actualReadingBody(h.root)).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
    } finally {
      if (finishPresent) await act(async () => finishPresent?.({ status: "cancelled" }))
      commitGate.hold = false
      h.view.unmount()
    }
  })
  it("wakes the first moved reading after a simultaneous real measurement with no page owner", () => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    h.move(600)
    reading.mockClear()
    const native = scrollFixture.latest.virtualizer
    const below = native.getVirtualItems().find(row => row.start > h.root.scrollTop + h.root.clientHeight)
    if (!below) throw new Error("A measured below-fold row is required")
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    const before = { total: native.getTotalSize(), height: h.root.scrollHeight }
    commitGate.hold = true
    fireEvent.wheel(h.root, { deltaY: -600 })
    scrollFixture.bodyHeights.set(String(below.key).slice(4), below.size + 80)
    resize(0)
    expect(native.getTotalSize()).toBeGreaterThan(before.total)
    expect(h.root.scrollHeight).toBeGreaterThan(before.height)
    act(() => h.root.scrollTo({ top: 0 }))
    runFrames(40)
    expect(h.root.scrollTop).toBe(0)
    expect(reading).not.toHaveBeenCalled()
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    expect(scrollFixture.frames.size).toBe(0)
    publishRows()
    runFrames(2)
    expect(actualReadingBody(h.root)).toBe("m0")
    expect(reading).toHaveBeenCalledExactlyOnceWith("m0")
    runFrames(40)
    expect(reading).toHaveBeenCalledOnce()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["above", "below"] as const)("does not turn passive %s-fold measurement after wheel intent into a reading move", location => {
    const reading = vi.fn()
    const h = mount({ items: Array.from({ length: 120 }, (_, index) => message(`m${index}`)), onReadingMessage: reading })
    h.move(600)
    reading.mockClear()
    const native = scrollFixture.latest.virtualizer
    const row = native.getVirtualItems().find(row => String(row.key).startsWith("msg:")
      && (location === "above" ? row.end <= h.root.scrollTop : row.start > h.root.scrollTop + h.root.clientHeight))
    if (!row) throw new Error("An actual measured row is required")
    const id = actualReadingBody(h.root)!
    const before = { offset: h.root.scrollTop, body: bodyTop(h.root, id), total: native.getTotalSize() }
    commitGate.hold = true
    fireEvent.wheel(h.root, { deltaY: -600 })
    scrollFixture.bodyHeights.set(String(row.key).slice(4), row.size + 80)
    resize(0)
    publishRows()
    runFrames(40)
    expect(native.getTotalSize()).toBeGreaterThan(before.total)
    expect(h.root.scrollTop).toBe(location === "above" ? before.offset + 80 : before.offset)
    expect(bodyTop(h.root, id)).toBe(before.body)
    expect(actualReadingBody(h.root)).toBe(id)
    expect(reading).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
  })
  it("stays dormant without a commit and wakes once from the real callback without pagination or another movement", () => {
    const { h, reading } = pendingReader()
    try {
      fireEvent.wheel(h.root, { deltaY: -800 })
      runFrames(40)
      expect(scrollFixture.latest.virtualizer.isScrolling).toBe(false)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const requests = vi.mocked(window.requestAnimationFrame).mock.calls.length
      runFrames(8)
      expect(vi.mocked(window.requestAnimationFrame).mock.calls).toHaveLength(requests)
      expect(scrollFixture.latest.paginationRequestPending).toBe(false)
      const before = h.root.scrollTop
      publishRows()
      runFrames(2)
      expect(h.root.scrollTop).toBe(before)
      expect(actualReadingBody(h.root)).toBe("m0")
      expect(reading).toHaveBeenCalledExactlyOnceWith("m0")
      resize(50)
      fireEvent.scroll(h.root)
      runFrames(4)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["target", "present", "hidden"] as const)("does not carry cancelled movement through %s retirement before the next frame", async retirement => {
    const { h, reading } = pendingReader()
    let finishPresent: ((result: MessageRequestResult) => void) | undefined
    try {
      if (retirement === "target") h.stage({ scrollToMessageId: "m20" })
      else if (retirement === "present") {
        const completed = new Promise<MessageRequestResult>(resolve => { finishPresent = resolve })
        act(() => scrollFixture.latest.requestPresentPosition({ accepted: true, completed }))
      }
      else { h.stage({ active: false }); h.stage({ active: true }) }
      expect(h.root.scrollTop).toBe(0)
      fireEvent.wheel(h.root, { deltaY: -800 })
      publishRows()
      runFrames(40)
      expect(h.root.scrollTop).toBe(0)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(actualReadingBody(h.root)).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
    } finally {
      if (finishPresent) await act(async () => finishPresent?.({ status: "cancelled" }))
      commitGate.hold = false
      h.view.unmount()
    }
  })
  it.each((["window", "items", "both"] as const).flatMap(scope => [false, true].map(continued => [scope, continued] as const)))("retains actual movement through same-owner %s publication with continued intent=%s", (scope, continued) => {
    const { h, reading } = pendingReader()
    try {
      h.stage({ ...(scope !== "items" ? { messageWindow: {} } : {}), ...(scope !== "window" ? { items: [...h.input.items] } : {}) })
      if (continued) fireEvent.wheel(h.root, { deltaY: -800 })
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const before = h.root.scrollTop
      publishRows()
      runFrames(2)
      expect(h.root.scrollTop).toBe(before)
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
      resize(40)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["window", "items", "both"] as const)("continues real displacement without a new wheel after commit-only %s acceptance", scope => {
    const { h, reading } = pendingReader()
    try {
      h.stage({ ...(scope !== "items" ? { messageWindow: {} } : {}), ...(scope !== "window" ? { items: [...h.input.items] } : {}) })
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const before = h.root.scrollTop
      publishRows()
      runFrames(2)
      expect(h.root.scrollTop).toBe(before)
      let previous = actualReadingBody(h.root)
      expect(previous).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(previous)
      for (const [index, offset] of [500, 900].entries()) {
        act(() => h.root.scrollTo({ top: offset }))
        resize(40)
        expect(h.root.scrollTop).toBe(offset)
        const current = actualReadingBody(h.root)
        expect(current).toBeDefined()
        expect(current).not.toBe(previous)
        expect(reading).toHaveBeenCalledTimes(index + 2)
        expect(reading).toHaveBeenLastCalledWith(current)
        expect(scrollFixture.frames.size).toBe(0)
        previous = current
      }
      fireEvent.scroll(h.root)
      resize(40)
      expect(reading).toHaveBeenCalledTimes(3)
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["viewport", "padding"] as const)("continues the same gesture after commit-only acceptance of changed %s geometry", geometry => {
    const { h, reading } = pendingReader()
    try {
      if (geometry === "viewport") { scrollFixture.height = 620; scrollFixture.width = 400 }
      else h.stage({ tailPaddingEnd: 80 })
      resize(0)
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const before = h.root.scrollTop
      publishRows()
      runFrames(2)
      expect(h.root.scrollTop).toBe(before)
      const first = actualReadingBody(h.root)
      expect(first).toBeDefined()
      expect(reading).toHaveBeenCalledExactlyOnceWith(first)
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(h.root.scrollTop).toBe(500)
      const current = actualReadingBody(h.root)
      expect(current).toBeDefined()
      expect(current).not.toBe(first)
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(current)
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it("does not revive a reading owner hidden by its own acceptance callback", () => {
    const { h, reading } = pendingReader()
    try {
      h.stage({ messageWindow: {}, items: [...h.input.items] })
      reading.mockImplementationOnce(() => h.stage({ active: false }))
      publishRows()
      runFrames(2)
      expect(reading).toHaveBeenCalledOnce()
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
      h.update({ active: true })
      expect(reading).toHaveBeenCalledTimes(2)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
      act(() => h.root.scrollTo({ top: 900 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(2)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 1300 }))
      resize(40)
      expect(reading).toHaveBeenCalledTimes(3)
      expect(reading).toHaveBeenLastCalledWith(actualReadingBody(h.root))
    } finally { commitGate.hold = false; h.view.unmount() }
  })
  it.each(["entry", "hidden", "retired"] as const)("does not revive published movement after %s ownership ends", retirement => {
    const { h, reading } = pendingReader()
    try {
      h.stage({ messageWindow: {}, items: [...h.input.items] })
      const stale = commitGate.publish!
      if (retirement === "retired") {
        h.view.unmount()
        commitGate.hold = false
        act(() => stale())
        runFrames(40)
        expect(reading).not.toHaveBeenCalled()
        expect(scrollFixture.frames.size).toBe(0)
        return
      }
      if (retirement === "entry") h.stage({ positionEntry: {} })
      else { h.stage({ active: false }); h.stage({ active: true }) }
      fireEvent.wheel(h.root, { deltaY: -800 })
      publishRows()
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      fireEvent.wheel(h.root, { deltaY: 800 })
      act(() => h.root.scrollTo({ top: 500 }))
      resize(40)
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
    } finally { commitGate.hold = false; h.view.unmount() }
  })

  it("waits for current data after real movement and a committed replacement window", () => {
    const { h, reading } = pendingReader()
    try {
      h.stage({ positionDataState: "pending", messageWindow: {}, items: [...h.input.items] })
      publishRows()
      runFrames(40)
      expect(reading).not.toHaveBeenCalled()
      expect(scrollFixture.frames.size).toBe(0)
      const before = h.root.scrollTop
      h.update({ positionDataState: "ready" })
      expect(h.root.scrollTop).toBe(before)
      expect(reading).toHaveBeenCalledExactlyOnceWith(actualReadingBody(h.root))
      resize(40)
      expect(reading).toHaveBeenCalledOnce()
      expect(scrollFixture.frames.size).toBe(0)
    } finally { commitGate.hold = false; h.view.unmount() }
  })

})
