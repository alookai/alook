import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("locked native adapter and existing message scroll owner", () => {
  it("delivers only the changed observed box and keeps content, client and border sizes separate", () => {
    scrollFixture.scrollbarWidth = 11
    const h = mount()
    h.root.style.padding = "7px 10px"
    const content = vi.fn<ResizeObserverCallback>()
    const border = vi.fn<ResizeObserverCallback>()
    const contentObserver = new ResizeObserver(content)
    const borderObserver = new ResizeObserver(border)
    contentObserver.observe(h.root)
    borderObserver.observe(h.root, { box: "border-box" })
    resize(0)
    expect(content).toHaveBeenCalledOnce()
    expect(border).toHaveBeenCalledOnce()
    expect(content.mock.calls[0][1]).toBe(contentObserver)
    expect(h.root.clientWidth).toBe(309)
    expect(content.mock.calls[0][0][0].target).toBe(h.root)
    expect(content.mock.calls[0][0][0]).toMatchObject({
      borderBoxSize: [{ inlineSize: 320, blockSize: 500 }],
      contentBoxSize: [{ inlineSize: 289, blockSize: 486 }],
      contentRect: { x: 10, y: 7, width: 289, height: 486 },
    })
    resize(0)
    expect(content).toHaveBeenCalledOnce()
    expect(border).toHaveBeenCalledOnce()
    scrollFixture.scrollbarWidth = 21
    resize(0)
    expect(content).toHaveBeenCalledTimes(2)
    expect(border).toHaveBeenCalledOnce()
    expect(content.mock.lastCall![0][0]).toMatchObject({
      borderBoxSize: [{ inlineSize: 320, blockSize: 500 }],
      contentBoxSize: [{ inlineSize: 279, blockSize: 486 }],
    })
    contentObserver.disconnect()
    borderObserver.disconnect()
  })
  it("retires removed observations and starts a fresh delivery after reobserve", () => {
    const h = mount()
    const callback = vi.fn<ResizeObserverCallback>()
    const observer = new ResizeObserver(callback)
    observer.observe(h.root)
    resize(0)
    expect(callback).toHaveBeenCalledOnce()
    observer.unobserve(h.root)
    scrollFixture.width += 10
    resize(0)
    expect(callback).toHaveBeenCalledOnce()
    observer.observe(h.root, { box: "border-box" })
    resize(0)
    expect(callback).toHaveBeenCalledTimes(2)
    resize(0)
    expect(callback).toHaveBeenCalledTimes(2)
    observer.disconnect()
    scrollFixture.height += 10
    resize(0)
    expect(callback).toHaveBeenCalledTimes(2)
    h.view.unmount()
    const before = scrollFixture.scrollCalls.length
    resize()
    expect(scrollFixture.scrollCalls).toHaveLength(before)
    expect(scrollFixture.frames.size).toBe(0)
  })
  it.each(["present", "away"])("keeps the %s position when the border height changes without a range change", position => {
    scrollFixture.bodyHeights.set("m0", 1800)
    const h = mount({ items: [message("m0")], hasMoreOlder: false })
    if (position === "away") h.move(300)
    const before = bodyTop(h.root, "m0")
    const native = scrollFixture.latest.virtualizer
    const range = { ...native.range }
    expect(native.isScrolling).toBe(false)
    scrollFixture.height -= 100
    resize()
    expect(native.range).toMatchObject({ startIndex: range.startIndex, endIndex: range.endIndex })
    expect(native.isScrolling).toBe(false)
    if (position === "present") expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    else expect(bodyTop(h.root, "m0")).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it.each(["present", "away"])("keeps the %s position when only the client height changes at a stable border box", position => {
    const h = mount()
    if (position === "away") h.move(300)
    const before = bodyTop(h.root, position === "away" ? "m2" : "m13")
    const native = scrollFixture.latest.virtualizer
    const rect = { ...native.scrollRect }
    expect(scrollFixture.frames.size).toBe(0)
    h.root.style.borderBottom = "100px solid transparent"
    expect(h.root.clientHeight).toBe(400)
    expect(h.root.offsetHeight).toBe(500)
    resize()
    expect(native.scrollRect).toEqual(rect)
    if (position === "present") expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    else expect(bodyTop(h.root, "m2")).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("keeps a settled target and page anchor through a content-only gutter change", () => {
    const positioned = vi.fn()
    const h = mount({ onScrollTargetPositioned: positioned })
    h.update({ scrollToMessageId: "m4" })
    expect(positioned).toHaveBeenCalledWith("m4")
    const top = bodyTop(h.root, "m4")
    const rect = { ...scrollFixture.latest.virtualizer.scrollRect }
    scrollFixture.scrollbarWidth = 11
    resize()
    expect(scrollFixture.latest.virtualizer.scrollRect).toEqual(rect)
    expect(bodyTop(h.root, "m4")).toBe(top)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const before = bodyTop(h.root, "m0")
    scrollFixture.scrollbarWidth = 21
    resize()
    h.update({ items: [message("older"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(before, 0)
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
  })
  it("does not restore the old origin after a reader scroll with a rejected pending row position", () => {
    const h = mount({ items: Array.from({ length: 28 }, (_, i) => message(`m${i}`)) })
    h.move(0)
    fireEvent.wheel(h.root, { deltaY: 600 })
    runFrames(2)
    const rows = Array.from(h.root.querySelectorAll<HTMLElement>("[data-index]"))
    for (const row of rows) {
      const measured = row.getBoundingClientRect.bind(row)
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const rect = measured()
          return DOMRect.fromRect({ x: rect.x, y: rect.y + 8, width: rect.width, height: rect.height })
        },
      })
    }
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    act(() => h.root.scrollTo({ top: 600 }))
    runFrames(2)
    expect(h.root.scrollTop).toBe(600)
    scrollFixture.firstPrefix += 8
    for (const row of rows) Reflect.deleteProperty(row, "getBoundingClientRect")
    resize()
    expect(h.root.scrollTop).toBe(608)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([undefined, "Today"])("uses the native border box for an unread divider with date label %s", dateLabel => {
    const unread = message("m0")
    unread.newDivider = true
    unread.dateLabel = dateLabel
    const h = mount({ items: [unread], hasMoreOlder: false })
    const divider = h.root.querySelector<HTMLElement>("[data-message-divider-for]")!.closest<HTMLElement>("[data-index]")!
    Object.defineProperty(divider, "scrollHeight", { configurable: true, value: 18 })
    const entry = {
      target: divider,
      borderBoxSize: [{ blockSize: 16, inlineSize: scrollFixture.width }],
    } as unknown as ResizeObserverEntry
    const native = scrollFixture.latest.virtualizer

    expect(native.options.measureElement(divider, entry, native)).toBe(16)
  })
  it("retains message body overflow when the native border box is smaller", () => {
    const h = mount({ items: [message("m0")], hasMoreOlder: false })
    const row = h.root.querySelector<HTMLElement>("[data-msg-id]")!.closest<HTMLElement>("[data-index]")!
    Object.defineProperty(row, "scrollHeight", { configurable: true, value: 967 })
    const entry = {
      target: row,
      borderBoxSize: [{ blockSize: 400, inlineSize: scrollFixture.width }],
    } as unknown as ResizeObserverEntry
    const native = scrollFixture.latest.virtualizer

    expect(native.options.measureElement(row, entry, native)).toBe(967)
  })
  it.each([2, 26])("keeps a present landing after %i frames through consecutive responsive widths", frames => {
    scrollFixture.width = 905
    scrollFixture.height = 783
    scrollFixture.firstPrefix = 193
    const h = mount({ items: Array.from({ length: 28 }, (_, i) => message(`m${i}`)), tailPaddingEnd: 48 })
    h.move(0)
    act(() => scrollFixture.latest.scrollToBottom())
    runFrames(frames)
    scrollFixture.width = 639
    resize(0)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    scrollFixture.width = 265
    scrollFixture.height = 727
    scrollFixture.firstPrefix = 233
    for (const item of h.input.items) scrollFixture.bodyHeights.set(item.m.id, 190)
    h.stage({ tailPaddingEnd: 48 })
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.belowCount).toBe(0)
  })
  it.each(["scroll", "measurement"])("retries rejected Present geometry within two frames on an unchanged-viewport %s event", event => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.scrollToBottom())
    const pending = Array.from(h.root.querySelectorAll<HTMLElement>("[data-index]"))
    for (const row of pending) Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true, value: () => DOMRect.fromRect(),
    })
    runFrames(3)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    runFrames(400)
    expect(scrollFixture.frames.size).toBe(0)
    for (const row of pending) Reflect.deleteProperty(row, "getBoundingClientRect")
    act(() => {
      if (event === "scroll") fireEvent.scroll(h.root)
      else {
        const row = pending.find(row => row.querySelector('[data-msg-id="m13"]'))!
        scrollFixture.bodyHeights.set("m13", 101)
        scrollFixture.latest.virtualizer.measureElement(row)
      }
    })
    runFrames(2)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  })
  it("uses auto for loaded-tail Present without the old timeout or pure viewport end reissue", () => {
    const h = mount()
    h.move(0)
    const native = scrollFixture.latest.virtualizer
    const end = vi.spyOn(native, "scrollToEnd")
    const offset = vi.spyOn(native, "scrollToOffset")
    vi.spyOn(h.root, "scrollTo").mockImplementation(() => {})
    act(() => scrollFixture.latest.scrollToBottom())
    runFrames(3)
    expect(end).toHaveBeenCalledExactlyOnceWith({ behavior: "auto" })
    runFrames(400)
    expect(scrollFixture.frames.size).toBe(0)
    scrollFixture.width = 390
    resize(2)
    expect(end).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(2100))
    expect(offset).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    fireEvent.wheel(h.root, { deltaY: -20 })
    expect(offset).toHaveBeenCalledOnce()
  })
  it("keeps an explicit tail scroll when wrapped offscreen rows receive their later native measurements", () => {
    scrollFixture.width = 639
    scrollFixture.height = 736
    scrollFixture.firstPrefix = 193
    const h = mount({ items: Array.from({ length: 28 }, (_, i) => message(`m${i}`)), tailPaddingEnd: 40 })
    act(() => h.root.scrollTo({ top: 0 }))
    runFrames()
    scrollFixture.width = 265
    scrollFixture.height = 727
    scrollFixture.firstPrefix = 233
    for (const item of h.input.items) scrollFixture.bodyHeights.set(item.m.id, 190)
    h.update({ tailPaddingEnd: 48 })
    expect(h.root.scrollTop).toBe(0)
    act(() => h.root.scrollTo({ top: h.root.scrollHeight }))
    runFrames()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.belowCount).toBe(0)
  })
  it("keeps a newly selected content origin across a pending width measurement and later footer render", () => {
    scrollFixture.width = 905
    scrollFixture.height = 783
    scrollFixture.firstPrefix = 193
    const h = mount({ items: Array.from({ length: 28 }, (_, i) => message(`m${i}`)), tailPaddingEnd: 48 })
    h.move(300)
    scrollFixture.width = 390
    scrollFixture.height = 736
    scrollFixture.firstPrefix = 213
    for (const item of h.input.items) scrollFixture.bodyHeights.set(item.m.id, 154)
    h.stage({ tailPaddingEnd: 40 })
    act(() => h.root.scrollTo({ top: 0 }))
    resize(2)
    expect(h.root.scrollTop).toBe(0)
    const before = { height: h.root.clientHeight, total: h.root.scrollHeight, top: bodyTop(h.root, "m0") }
    runFrames(8)
    h.stage({ items: [...h.input.items] })
    resize()
    expect(h.root.clientHeight).toBe(before.height)
    expect(h.root.scrollHeight).toBe(before.total)
    expect(h.root.scrollTop).toBe(0)
    expect(bodyTop(h.root, "m0")).toBe(before.top)
  })
  it.each(["programmatic", "wheel"])("keeps the absolute content origin after responsive hero growth and %s top positioning without typing", input => {
    scrollFixture.width = 906
    scrollFixture.firstPrefix = 193
    const h = mount()
    h.move(0)
    scrollFixture.width = 390
    scrollFixture.firstPrefix = 213
    h.stage({ items: [...h.input.items] })
    if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -20 })
    act(() => h.root.scrollTo({ top: 0 }))
    resize(2)
    const before = { height: h.root.clientHeight, total: h.root.scrollHeight, top: h.root.scrollTop, body: bodyTop(h.root, "m0") }
    expect(before.top).toBe(0)
    expect(before.body).toBe(213)
    runFrames()
    expect(h.root.clientHeight).toBe(before.height)
    expect(h.root.scrollHeight).toBe(before.total)
    expect(h.root.scrollTop).toBe(0)
    expect(bodyTop(h.root, "m0")).toBe(before.body)
  })
  it("keeps an existing short-list pin at the new maximum after responsive body growth", () => {
    scrollFixture.width = 906
    scrollFixture.firstPrefix = 193
    const h = mount({ items: [message("m0")], hasMoreOlder: false })
    expect(h.root.scrollHeight).toBe(h.root.clientHeight)
    expect(h.root.scrollTop).toBe(0)
    scrollFixture.width = 390
    scrollFixture.firstPrefix = 213
    scrollFixture.bodyHeights.set("m0", 800)
    h.stage({ items: [...h.input.items] })
    resize()
    expect(h.root.scrollHeight).toBeGreaterThan(h.root.clientHeight)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.belowCount).toBe(0)
  })
  it.each(["wheel", "target"])("retires a short-list pin when %s takes ownership before overflow", input => {
    const h = mount({ items: [message("m0"), message("m1")], hasMoreOlder: false })
    expect(h.root.scrollHeight).toBe(h.root.clientHeight)
    if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -20 })
    else h.stage({ scrollToMessageId: "m0" })
    scrollFixture.bodyHeights.set("m1", 900)
    h.stage({ items: [...h.input.items] })
    resize()
    expect(h.root.scrollHeight).toBeGreaterThan(h.root.clientHeight)
    expect(h.root.scrollTop).toBeLessThan(100)
    expect(bodyTop(h.root, "m0")).toBeGreaterThanOrEqual(0)
  })
  it("keeps the existing first-message body when history is prepended at the content origin", () => {
    const h = mount()
    h.move(0)
    const before = bodyTop(h.root, "m0")
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    h.update({ items: [message("older"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(before, 0)
  })
  it.each(["m0", "m1"])("keeps a settled %s target when a short list later grows beyond the viewport", id => {
    const positioned = vi.fn()
    const h = mount({ items: [message("m0"), message("m1"), message("m2")], hasMoreOlder: false, onScrollTargetPositioned: positioned })
    h.update({ scrollToMessageId: id })
    resize()
    expect(positioned).toHaveBeenCalledWith(id)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(h.root.scrollHeight).toBe(h.root.clientHeight)
    scrollFixture.bodyHeights.set("m2", 900)
    h.update({ items: [...h.input.items] })
    expect(h.root.scrollHeight).toBeGreaterThan(h.root.clientHeight)
    expect(h.root.scrollTop).toBeLessThan(100)
    expect(bodyTop(h.root, id)).toBeGreaterThanOrEqual(0)
  })
  it.each(["target", "unread"])("keeps a newly landed %s origin through consecutive widths and overflow", intent => {
    scrollFixture.width = 905
    scrollFixture.height = 783
    scrollFixture.firstPrefix = 193
    const items = [message("m0"), message("m1"), message("m2")]
    if (intent === "unread") items[0].newDivider = true
    const positioned = vi.fn()
    const h = mount({
      items, hasMoreOlder: false, hasMoreNewer: intent === "unread",
      initialScrollReady: intent !== "unread",
      newDividerBefore: intent === "unread" ? "m0" : undefined,
      onScrollTargetPositioned: positioned,
    })
    h.stage(intent === "target" ? { scrollToMessageId: "m0" } : { initialScrollReady: true })
    runFrames(2)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    if (intent === "target") expect(positioned).toHaveBeenCalledWith("m0")
    expect(h.root.scrollTop).toBe(0)
    scrollFixture.width = 639
    resize(0)
    expect(h.root.scrollTop).toBe(0)
    scrollFixture.width = 265
    scrollFixture.height = 727
    scrollFixture.bodyHeights.set("m2", 900)
    resize()
    expect(h.root.scrollHeight).toBeGreaterThan(h.root.clientHeight)
    expect(h.root.scrollTop).toBe(0)
    expect(bodyTop(h.root, "m0")).toBeGreaterThanOrEqual(0)
    expect(bodyTop(h.root, "m0")).toBeLessThan(h.root.clientHeight)
  })
  it("unifies native total and DOM max while keeping 40/48px rail clearance", () => {
    const h = mount()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.virtualizer.options).toMatchObject({ anchorTo: "end", followOnAppend: false, scrollEndThreshold: 1, scrollMargin: 0, paddingEnd: 40 })
    expect(h.root.scrollHeight).toBe(scrollFixture.latest.virtualizer.getTotalSize())
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - scrollFixture.height)
    h.update({ tailPaddingEnd: 40 })
    expect(h.root.scrollHeight).toBe(scrollFixture.latest.virtualizer.getTotalSize())
  })
  it("centers the independent New row beside a long message with the native index command", () => {
    scrollFixture.bodyHeights.set("m4", 1800)
    const items = Array.from({ length: 12 }, (_, i) => ({ ...message(`m${i}`), ...(i === 4 ? { newDivider: true } : {}) }))
    const h = mount({ items, newDividerBefore: "m4", hasMoreNewer: true })
    const marker = h.root.querySelector('[data-new-divider]')!.getBoundingClientRect()
    expect((marker.top + marker.bottom) / 2).toBeCloseTo(scrollFixture.height / 2, 0)
    expect(bodyTop(h.root, "m4")).toBeLessThan(scrollFixture.height)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("clamps a first-row merged date/New boundary to the actual content origin", () => {
    scrollFixture.firstPrefix = 152
    scrollFixture.bodyHeights.set("first", 1800)
    const item = { ...message("first"), dateLabel: "Today", newDivider: true }
    const h = mount({ items: [item], hasMoreOlder: false, newDividerBefore: "first" })
    const marker = h.root.querySelector('[data-new-divider]')!.getBoundingClientRect()
    expect(h.root.scrollTop).toBe(0)
    expect(marker.top).toBeGreaterThanOrEqual(0)
    expect(marker.bottom).toBeLessThan(scrollFixture.height)
    expect(bodyTop(h.root, "first")).toBeLessThan(scrollFixture.height)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("shows after the original deadline while keeping read and peer follow closed", () => {
    const shown = vi.fn()
    const h = mount({ initialScrollReady: false, hasMoreNewer: true, onInitialPositionSettled: shown })
    act(() => vi.advanceTimersByTime(2000))
    runFrames()
    expect(shown).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.virtualizer.options.anchorTo).toBe("start")
    const before = h.root.scrollTop
    h.update({ items: [...h.input.items, message("late-peer")] })
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.move(300)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("preserves and settles a prefix page after deadline retirement without opening read or peer follow", () => {
    const h = mount({ initialScrollReady: false, hasMoreNewer: true })
    expect(scrollFixture.latest.paginationEnabled).toBe(false)
    act(() => vi.advanceTimersByTime(2000))
    runFrames()
    act(() => h.root.scrollTo({ top: 0 }))
    resize()
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    scrollFixture.firstPrefix += 40
    resize()
    const before = bodyTop(h.root, "m0")
    h.update({ items: [message("older-0"), message("older-1"), message("older-2"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(before, 0)
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.virtualizer.options).toMatchObject({ anchorTo: "start", followOnAppend: false })
  })
  it.each(["m0", "m1"])("uses native row anchoring when the pending page reaches %s with an unchanged body inset", id => {
    const h = mount({ initialScrollReady: false, hasMoreNewer: true })
    act(() => vi.advanceTimersByTime(2000))
    runFrames()
    act(() => h.root.scrollTo({ top: 0 }))
    resize()
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    expect(scrollFixture.latest.virtualizer.options).toMatchObject({ anchorTo: "end", followOnAppend: false })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    const row = scrollFixture.latest.virtualizer.getVirtualItems().find(item => item.key === `msg:${id}`)!
    act(() => h.root.scrollTo({ top: row.start + 30 }))
    resize()
    const before = bodyTop(h.root, id)
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    h.update({ items: [message("older-0"), message("older-1"), message("older-2"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, id)).toBeCloseTo(before, 0)
    expect(index).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
    expect(scrollFixture.latest.virtualizer.options).toMatchObject({ anchorTo: "start", followOnAppend: false })
    const settledOffset = h.root.scrollTop
    h.update({ items: [...h.input.items, message("late-peer")] })
    expect(h.root.scrollTop).toBe(settledOffset)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })
  it("does not let pagination retire an unresolved initial intent or its deadline", () => {
    const shown = vi.fn()
    const h = mount({ initialScrollReady: false, hasMoreNewer: true, onInitialPositionSettled: shown })
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    h.update({ isFetchingOlder: false })
    expect(scrollFixture.latest.virtualizer.options.anchorTo).toBe("start")
    act(() => vi.advanceTimersByTime(2000))
    expect(shown).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })
  it("uses stable native keys for ordinary prepend without a business index restore", () => {
    const h = mount()
    h.move(500)
    const top = bodyTop(h.root, "m5")
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    h.update({ items: [message("older"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m5")).toBeCloseTo(top, 0)
    expect(index).not.toHaveBeenCalled()
    expect(offset).not.toHaveBeenCalled()
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
  })
  it("keeps quote smooth on the native index command without a per-frame offset rewrite", () => {
    const h = mount()
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    act(() => scrollFixture.latest.jumpTo("m5", "smooth"))
    runFrames()
    expect(index).toHaveBeenCalledWith(6, { align: "center", behavior: "smooth" })
    expect(offset).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("keeps the header-fold message when the newly inserted preceding row grows during native restore", () => {
    const h = mount()
    h.move(0)
    const top = bodyTop(h.root, "m0")
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.stage({ items: [...older, ...h.input.items], isFetchingOlder: false })
    resize(2)
    expect(bodyTop(h.root, "m0")).toBe(top)
    scrollFixture.bodyHeights.set("older-29", 108)
    resize()
    expect(bodyTop(h.root, "m0")).toBe(top)
  })
  it.each([-24, 40])("captures the current old-window position after a pending prefix change of %ipx", delta => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    scrollFixture.firstPrefix += delta
    resize()
    const currentTop = bodyTop(h.root, "m0")
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.update({ items: [...older, ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m0")).toBe(currentTop)
  })
  it("keeps the page settlement gate after the fetch ends until native geometry settles", () => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.stage({ items: [...older, ...h.input.items], isFetchingOlder: false })
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(true)
    resize(2)
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(true)
    runFrames()
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
  })
  it.each(["wheel", "target"])("retires a pending header page when %s takes ownership before the response", input => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(true)
    if (input === "wheel") h.move(350)
    else {
      act(() => scrollFixture.latest.jumpTo("m8", "auto"))
      runFrames()
    }
    expect(scrollFixture.latest.isOlderPageAnchorSettling).toBe(false)
    const before = bodyTop(h.root, input === "wheel" ? "m3" : "m8")
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.update({ items: [...older, ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, input === "wheel" ? "m3" : "m8")).toBe(before)
    expect(index).not.toHaveBeenCalled()
    expect(scrollFixture.latest.virtualizer.shouldAdjustScrollPositionOnItemSizeChange).toBeUndefined()
  })
  it("returns to native measurement policy when the header-fold restore settles", () => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.update({ items: [...older, ...h.input.items], isFetchingOlder: false })
    const readingTop = bodyTop(h.root, "older-29")
    const restoredTop = bodyTop(h.root, "m0")
    scrollFixture.bodyHeights.set("older-29", 108)
    resize()
    expect(bodyTop(h.root, "older-29")).toBe(readingTop)
    expect(bodyTop(h.root, "m0")).toBe(restoredTop + 8)
  })
  it("lets the reader keep the new spanning row after taking over a header-fold restore", () => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.update({ items: [...older, ...h.input.items], isFetchingOlder: false })
    h.move(h.root.scrollTop)
    const readingTop = bodyTop(h.root, "older-29")
    const retiredTop = bodyTop(h.root, "m0")
    scrollFixture.bodyHeights.set("older-29", 108)
    resize()
    expect(bodyTop(h.root, "older-29")).toBe(readingTop)
    expect(bodyTop(h.root, "m0")).toBe(retiredTop + 8)
  })
  it("returns to native measurement policy when the captured header-fold message is removed", () => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.stage({ items: [...older, ...h.input.items], isFetchingOlder: false })
    resize(2)
    h.stage({ items: h.input.items.filter(item => item.m.id !== "m0") })
    resize(0)
    expect(scrollFixture.latest.virtualizer.shouldAdjustScrollPositionOnItemSizeChange).toBeUndefined()
    runFrames()
    const readingTop = bodyTop(h.root, "older-29")
    const nextTop = bodyTop(h.root, "m1")
    scrollFixture.bodyHeights.set("older-29", 108)
    resize()
    expect(bodyTop(h.root, "older-29")).toBe(readingTop)
    expect(bodyTop(h.root, "m1")).toBe(nextTop + 8)
  })
  it("uses native measurement policy for a new quote target after a header-fold restore", () => {
    const h = mount()
    h.move(0)
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.update({ isFetchingOlder: true })
    const older = Array.from({ length: 30 }, (_, index) => message(`older-${index}`))
    h.update({ items: [...older, ...h.input.items], isFetchingOlder: false })
    act(() => scrollFixture.latest.jumpTo("m10"))
    runFrames()
    const targetTop = bodyTop(h.root, "m10")
    scrollFixture.bodyHeights.set("m5", 108)
    resize()
    expect(bodyTop(h.root, "m10")).toBe(targetTop)
  })
  it("keeps the old first message through native anchoring after independent rows prepend", () => {
    scrollFixture.bodyHeights.set("m0", 1200)
    const h = mount()
    h.move(400)
    const top = bodyTop(h.root, "m0")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    h.update({ items: [message("older"), ...h.input.items] })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(top, 0)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each(["wheel", "programmatic"])("retains the current first-row body when prepend finishes before %s scroll quiet", input => {
    scrollFixture.bodyHeights.set("m0", 1200)
    const h = mount()
    if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -20 })
    act(() => h.root.scrollTo({ top: 400 }))
    runFrames(2)
    const top = bodyTop(h.root, "m0")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    act(() => scrollFixture.latest.captureOlderPageAnchor())
    h.stage({ isFetchingOlder: true })
    h.update({ items: [message("older"), ...h.input.items], isFetchingOlder: false })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(top, 0)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each(["peer", "me"])("follows a genuine %s append through later native tail measurement", author => {
    const h = mount({ viewerUserId: "me" })
    const top = author === "peer" ? h.root.scrollHeight - scrollFixture.height : 400
    h.move(top)
    h.stage({ items: [...h.input.items, message("new-tail", author)] })
    runFrames(2)
    scrollFixture.bodyHeights.set("new-tail", 456)
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it.each(["peer", "me"])("keeps a pending %s end intent on the current tail when another row arrives", author => {
    const h = mount({ viewerUserId: "me" })
    h.move(author === "peer" ? h.root.scrollHeight - scrollFixture.height : 400)
    h.stage({ items: [...h.input.items, message("first-tail", author)] })
    h.stage({ items: [...h.input.items, message("second-tail", author)] })
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("keeps a pending end intent on the current tail after history is prepended", () => {
    const h = mount({ viewerUserId: "me" })
    h.move(400)
    h.stage({ items: [...h.input.items, message("self-tail", "me")] })
    h.stage({ items: [message("older-one"), message("older-two"), ...h.input.items] })
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("does not duplicate native growth above the fold", () => {
    const h = mount()
    h.move(500)
    const top = bodyTop(h.root, "m5")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.bodyHeights.set("m0", 220)
    resize()
    expect(bodyTop(h.root, "m5")).toBeCloseTo(top, 0)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([0, 11])("settles same-anchor hero growth once with a %ipx scrollbar after native layout", gutter => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => scrollFixture.width - gutter)
    scrollFixture.bodyHeights.set("m0", 1200)
    const h = mount()
    h.move(400)
    const top = bodyTop(h.root, "m0")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.firstPrefix += 40
    h.update({ items: [...h.input.items] })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(top, 0)
    expect(offset).not.toHaveBeenCalled()
    resize()
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([0, 1, 2])("keeps passive growth separate at %ipx from the end", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.bodyHeights.set("m13", 180)
    resize()
    expect(h.root.scrollTop - before).toBe(distance <= 1 ? 80 : 0)
    expect(offset).not.toHaveBeenCalled()
  })
  it("does not add a second prefix correction to a pinned single long row", () => {
    scrollFixture.bodyHeights.set("m0", 1800)
    const h = mount({ items: [message("m0")] })
    const before = h.root.scrollTop
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.firstPrefix += 60
    h.update({ items: [...h.input.items] })
    expect(h.root.scrollTop - before).toBe(60)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([0, 99, 100, 101])("qualifies peer append from the actual prior %ipx tail distance", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    h.update({ items: [...h.input.items, message("peer-new")] })
    expect(end).toHaveBeenCalledTimes(distance <= 100 ? 1 : 0)
  })
  it("does not follow a historical self-authored tail from newer pagination", () => {
    const h = mount({ viewerUserId: "me" })
    h.move(300)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    act(() => scrollFixture.latest.captureNewerPageAnchor())
    h.update({ isFetchingNewer: true })
    h.update({ items: [...h.input.items, message("historical-me", "me")], isFetchingNewer: false })
    h.update({ items: [...h.input.items] })
    expect(end).not.toHaveBeenCalled()
  })
  it("does not revive a canceled Present when its tail arrives late", () => {
    const h = mount({ hasMoreNewer: true, newDividerBefore: "m4", items: Array.from({ length: 14 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 4 })) })
    act(() => scrollFixture.latest.requestPresentPosition())
    h.move(300)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    h.update({ items: [...h.input.items, message("historical-me", "me")], hasMoreNewer: false, presentVersion: 1, viewerUserId: "me" })
    h.update({ items: [...h.input.items] })
    expect(end).not.toHaveBeenCalled()
  })
  it("finishes only the active Present ticket when the current tail arrives", () => {
    const h = mount({ hasMoreNewer: true, newDividerBefore: "m4", items: Array.from({ length: 14 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 4 })) })
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    act(() => scrollFixture.latest.requestPresentPosition())
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ items: [...h.input.items, message("present-tail")], hasMoreNewer: false, presentVersion: 1 })
    expect(end).toHaveBeenCalledOnce()
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - scrollFixture.height)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h.update({ items: [...h.input.items] })
    expect(end).toHaveBeenCalledOnce()
  })
  it("waits for a positive viewport before proving the original semantic position", () => {
    scrollFixture.height = 0
    const h = mount({ newDividerBefore: "m4", items: Array.from({ length: 14 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 4 })) })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.height = 500
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    act(() => scrollFixture.latest.jumpTo("m8", "auto"))
    scrollFixture.height = 0
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.height = 500
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("does not settle prefix or footer candidates while a pointer or moving touch is active", () => {
    scrollFixture.bodyHeights.set("m0", 1800)
    const h = mount()
    h.move(400)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    fireEvent.pointerDown(h.root, { pointerId: 9 })
    scrollFixture.firstPrefix += 40
    h.update({ items: [...h.input.items] })
    expect(offset).not.toHaveBeenCalled()
    fireEvent.pointerUp(document, { pointerId: 9 })
    runFrames()
    fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(h.root, { touches: [{ clientY: 180 }] })
    scrollFixture.height -= 100
    resize()
    expect(offset).not.toHaveBeenCalled()
    fireEvent.blur(window)
    runFrames()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([0, 2, 100, 300])("retains the existing footer policy at %ipx and consumes duplicate delivery", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.height -= 100
    resize()
    expect(h.root.scrollTop).toBe(before + (distance <= 100 ? 100 : 0))
    const calls = offset.mock.calls.length
    resize()
    expect(offset).toHaveBeenCalledTimes(calls)
  })
  it.each([0, 2, 100, 300])("preserves the footer policy at %ipx when viewport growth changes the folded row", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    scrollFixture.height += 200
    resize()
    expect(h.root.scrollTop).toBe(before - (distance <= 100 ? 200 : 0))
    if (distance <= 100) expect(h.root.scrollHeight - scrollFixture.height - h.root.scrollTop).toBe(distance)
  })
  it("preserves a current two-pixel tail distance when the footer grows before the scroll quiet period", () => {
    const h = mount()
    act(() => h.root.scrollTo({ top: h.root.scrollHeight - scrollFixture.height - 2 }))
    runFrames(2)
    scrollFixture.height += 200
    resize()
    expect(h.root.scrollHeight - scrollFixture.height - h.root.scrollTop).toBe(2)
  })
  it.each([0, 2, 100, 101])("preserves the footer policy at %ipx across native mobile/desktop tail padding", distance => {
    const h = mount({ tailPaddingEnd: 40 })
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    h.update({ tailPaddingEnd: 48 })
    expect(h.root.scrollTop).toBe(before + (distance <= 100 ? 8 : 0))
    const calls = offset.mock.calls.length
    h.update({ items: [...h.input.items] })
    expect(offset).toHaveBeenCalledTimes(calls)
    if (distance === 0) {
      scrollFixture.bodyHeights.set("m13", 240)
      h.update({ items: [...h.input.items] })
      expect(h.root.scrollTop).toBe(h.root.scrollHeight - scrollFixture.height)
      expect(offset).toHaveBeenCalledTimes(calls)
    }
  })
  it.each([0, 11])("keeps a settled tail with a %ipx scrollbar through width wrapping and later native row measurements", gutter => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => scrollFixture.width - gutter)
    scrollFixture.width = 639
    scrollFixture.height = 736
    const h = mount({ tailPaddingEnd: 40 })
    scrollFixture.width = 266
    scrollFixture.height = 727
    for (const item of h.input.items) scrollFixture.bodyHeights.set(item.m.id, 190)
    h.stage({ tailPaddingEnd: 48 })
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
    scrollFixture.bodyHeights.set("m13", 420)
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.belowCount).toBe(0)
  })
  it("preserves an away reader through width wrapping without an end command", () => {
    scrollFixture.width = 639
    const h = mount({ tailPaddingEnd: 40 })
    h.move(300)
    const top = bodyTop(h.root, "m2")
    scrollFixture.width = 266
    for (const item of h.input.items) scrollFixture.bodyHeights.set(item.m.id, 190)
    h.update({ tailPaddingEnd: 48 })
    expect(bodyTop(h.root, "m2")).toBe(top)
  })
  it("retires width-triggered native end positioning when the user takes over", () => {
    scrollFixture.width = 639
    const h = mount({ tailPaddingEnd: 40 })
    scrollFixture.width = 266
    h.stage({ tailPaddingEnd: 48 })
    resize(2)
    h.move(300)
    const before = h.root.scrollTop
    scrollFixture.bodyHeights.set("m13", 420)
    resize()
    expect(h.root.scrollTop).toBe(before)
  })
  it("preserves a two-pixel DM tail distance through consecutive composer resizes", () => {
    const h = mount()
    scrollFixture.height -= 100
    resize(2)
    act(() => h.root.scrollTo({ top: h.root.scrollHeight - scrollFixture.height - 2 }))
    runFrames(2)
    scrollFixture.height += 100
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
  })
  it.each([0, 2, 8, 100, 300])("preserves the %ipx footer policy in the first two resize frames", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    scrollFixture.height += 200
    resize(2)
    if (distance <= 100) expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(distance)
    else expect(h.root.scrollTop).toBe(before)
  })
  it.each([[40, 48], [48, 40]])("retains an explicit present scroll after padding changes from %i to %i", (from, to) => {
    const h = mount({ tailPaddingEnd: from })
    h.move(300)
    h.stage({ tailPaddingEnd: to })
    act(() => h.root.scrollTo({ top: h.root.scrollHeight }))
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.belowCount).toBe(0)
  })
  it.each(["wheel", "touch", "pointer"])("keeps footer clamp compensation behind active %s input", input => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    if (input === "wheel") fireEvent.wheel(h.root, { deltaY: -2 })
    if (input === "touch") fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    if (input === "pointer") fireEvent.pointerDown(h.root, { pointerId: 9 })
    scrollFixture.height += 100
    resize(2)
    expect(offset).not.toHaveBeenCalled()
  })
  it("does not treat a resize clamp during ongoing native scrolling as a settled footer", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 8)
    act(() => h.root.scrollTo({ top: h.root.scrollTop + 6 }))
    runFrames(2)
    expect(scrollFixture.latest.virtualizer.isScrolling).toBe(true)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.height += 100
    resize(2)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each(["document", "footer"])("keeps a settled viewport anchor after an unregistered %s pointer release", target => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const footer = h.root.closest('[data-slot="community-conversation-surface"]')!
      .querySelector('[data-slot="community-conversation-footer"]')!
    const release = new Event("pointerup", { bubbles: true })
    Object.defineProperty(release, "pointerId", { value: 41 })
    fireEvent(target === "document" ? document : footer, release)
    scrollFixture.height += 100
    resize(2)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
  })
  it("keeps a real scroller pointer protected when released outside the scroller", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    const down = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(down, "pointerId", { value: 41 })
    fireEvent(h.root, down)
    const up = new Event("pointerup", { bubbles: true })
    Object.defineProperty(up, "pointerId", { value: 41 })
    fireEvent(document, up)
    scrollFixture.height += 100
    resize(2)
    expect(offset).not.toHaveBeenCalled()
  })
  it("does not release an active scroller pointer when another pointer ends outside", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    const down = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(down, "pointerId", { value: 41 })
    fireEvent(h.root, down)
    const up = new Event("pointerup", { bubbles: true })
    Object.defineProperty(up, "pointerId", { value: 42 })
    fireEvent(document, up)
    runFrames(13)
    scrollFixture.height += 100
    resize(2)
    expect(offset).not.toHaveBeenCalled()
  })
  it.each([0, 1])("preserves a settled viewport tail distance after ResizeObserver and %i later RAFs", frames => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    scrollFixture.height += 100
    act(() => {
      h.root.scrollTop = h.root.scrollHeight - h.root.clientHeight
      h.root.dispatchEvent(new Event("scroll"))
    })
    resize(0)
    runFrames(frames)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
  })
  it.each([0, 2, 8, 100, 300])("preserves the %ipx footer policy in the first RAF before native ResizeObserver", distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    scrollFixture.height += 200
    runFrames(1)
    expect(h.root.scrollTop).toBe(before - (distance <= 100 ? 200 : 0))
    resize(0)
    expect(h.root.scrollTop).toBe(before - (distance <= 100 ? 200 : 0))
  })
  it("retains a settled viewport owner through successive first-RAF composer clamps", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    for (let i = 0; i < 3; i++) {
      scrollFixture.height += 50
      runFrames(1)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
      resize(0)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
      runFrames(1)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
    }
  })
  it("keeps a registered pointer cancellation protected outside the scroller", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    const down = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(down, "pointerId", { value: 41 })
    fireEvent(h.root, down)
    const cancel = new Event("pointercancel", { bubbles: true })
    Object.defineProperty(cancel, "pointerId", { value: 41 })
    fireEvent(document, cancel)
    scrollFixture.height += 100
    resize(2)
    expect(offset).not.toHaveBeenCalled()
  })
  it("retires a held scroller pointer after window blur and the input quiet window", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const down = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(down, "pointerId", { value: 41 })
    fireEvent(h.root, down)
    fireEvent(window, new Event("blur"))
    runFrames(13)
    scrollFixture.height += 100
    resize(2)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
  })
  it("rejects an unrelated native rectangle during a first-RAF viewport handoff", () => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.latest.virtualizer.scrollRect = { width: 320, height: 300 }
    scrollFixture.height += 100
    runFrames(1)
    expect(offset).not.toHaveBeenCalled()
  })
  it("keeps the content viewport anchor while native border-box delivery is pending with a scrollbar", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => scrollFixture.width - 11)
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - 2)
    scrollFixture.height += 100
    runFrames(1)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
    resize(0)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)
  })
  it.each([0, 2, 8, 100, 300])("preserves the %ipx footer policy before native RO when composer growth does not clamp", async distance => {
    const h = mount()
    h.move(h.root.scrollHeight - scrollFixture.height - distance)
    const before = h.root.scrollTop
    const footer = h.root.closest('[data-slot="community-conversation-surface"]')!
      .querySelector('[data-slot="community-conversation-footer"]')!
    await act(async () => {
      scrollFixture.height -= 100
      footer.textContent = "growing draft"
    })
    runFrames(1)
    expect(h.root.scrollTop).toBe(before + (distance <= 100 ? 100 : 0))
    resize(0)
    expect(h.root.scrollTop).toBe(before + (distance <= 100 ? 100 : 0))
  })
  it("fills a true single short message through native padding and crosses short/long normally", () => {
    const h = mount({ items: [message("m0")] })
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.virtualizer.getTotalSize()).toBe(scrollFixture.height)
    h.update({ items: Array.from({ length: 14 }, (_, i) => message(`m${i}`)) })
    expect(scrollFixture.latest.virtualizer.getTotalSize()).toBeGreaterThan(scrollFixture.height)
    h.update({ items: [message("m0")] })
    expect(scrollFixture.latest.virtualizer.getTotalSize()).toBe(scrollFixture.height)
    expect(scrollFixture.latest.virtualizer.options.paddingStart).toBeGreaterThan(0)
  })
  it("keeps a genuinely empty list free of message keys and positions the first actual message", () => {
    const h = mount({ items: [] })
    expect(scrollFixture.latest.virtualizer.getVirtualItems()).toEqual([])
    expect(h.root.querySelector('[data-msg-id]')).toBeNull()
    h.update({ items: [message("first")] })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.virtualizer.getVirtualItems().map(item => item.key)).toEqual(["rail:leading", "msg:first"])
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.virtualizer.getTotalSize()).toBe(scrollFixture.height)
  })
  it("stops idle geometry frames when the last message is removed", () => {
    const h = mount()
    h.update({ items: [] })
    runFrames()
    const frames = vi.mocked(window.requestAnimationFrame)
    frames.mockClear()
    runFrames(5)
    expect(frames).not.toHaveBeenCalled()
  })
  it("follows a new self-send once and retains its stable display key on canonical acknowledgement", () => {
    const h = mount({ viewerUserId: "me" })
    h.move(300)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    const optimistic = { ...message("optimistic", "me"), key: "client:send-1" }
    h.update({ items: [...h.input.items, optimistic] })
    expect(end).toHaveBeenCalledOnce()
    const canonical = { ...optimistic, m: { ...optimistic.m, id: "canonical" } }
    h.update({ items: [...h.input.items.slice(0, -1), canonical] })
    expect(end).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.virtualizer.getVirtualItems().at(-1)?.key).toBe("client:send-1")
  })
  it("keeps read closed at the early warm tail until the original unread boundary is proven", () => {
    const h = mount({ initialScrollReady: false })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - scrollFixture.height)
    h.update({ initialScrollReady: true, newDividerBefore: "m4", items: h.input.items.map(item => ({ ...item, newDivider: item.m.id === "m4" })) })
    const marker = h.root.querySelector('[data-new-divider]')!.getBoundingClientRect()
    expect((marker.top + marker.bottom) / 2).toBeCloseTo(scrollFixture.height / 2, 0)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it("combines current prefix growth with the existing footer reading-offset policy once", () => {
    scrollFixture.bodyHeights.set("m0", 1800)
    const h = mount()
    h.move(400)
    const before = bodyTop(h.root, "m0")
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    scrollFixture.height -= 100
    scrollFixture.firstPrefix += 40
    h.update({ items: [...h.input.items] })
    expect(bodyTop(h.root, "m0")).toBeCloseTo(before, 0)
    expect(offset).not.toHaveBeenCalled()
    resize()
    expect(offset).not.toHaveBeenCalled()
  })
})
