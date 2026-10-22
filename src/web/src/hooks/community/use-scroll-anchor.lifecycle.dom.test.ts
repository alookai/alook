import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, message, mount, resize, restoreMessageScrollFixture, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageRequest, MessageRequestResult } from "@/lib/community/message-position"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function request() {
  let finish!: (result: MessageRequestResult) => void
  const value: MessageRequest = { accepted: true, completed: new Promise(resolve => { finish = resolve }) }
  return { value, finish }
}

describe("qualified positioning lifecycle", () => {
  it.each(["visible", "inactive", "document-hidden", "size-change"])("measures a laid-out row on first activation from %s", mode => {
    scrollFixture.firstPrefix = 120
    const visibility = vi.spyOn(document, "visibilityState", "get")
    visibility.mockReturnValue(mode === "document-hidden" ? "hidden" : "visible")
    if (mode === "size-change") scrollFixture.firstPrefix = 0
    const h = mount({ active: mode !== "inactive" && mode !== "size-change", hasMoreOlder: false,
      items: [{ ...message("first"), newDivider: true }], newDividerBefore: "first" })
    if (mode === "document-hidden") {
      visibility.mockReturnValue("visible")
      fireEvent(document, new Event("visibilitychange"))
      resize()
    } else if (mode !== "visible") {
      if (mode === "size-change") scrollFixture.firstPrefix = 120
      h.update({ active: true })
    }
    expect({
      measured: scrollFixture.latest.virtualizer.getVirtualItems().find(item => item.key === "rail:leading")?.size,
      ready: scrollFixture.latest.readPositionReady,
    }).toEqual({ measured: 120, ready: true })
    expect(h.root.scrollTop).toBe(0)
  })

  it("preserves native cached measurements when a hidden row has no physical box", () => {
    const h = mount({ items: [message("first")], hasMoreOlder: false })
    const native = scrollFixture.latest.virtualizer
    const row = h.root.querySelector<HTMLElement>('[data-message-row-key="rail:leading"]')!.closest<HTMLElement>('[data-index]')!
    const measured = native.getVirtualItems().find(item => item.key === "rail:leading")!.size
    h.stage({ active: false })
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect())
    const entry = { target: row, borderBoxSize: [{ blockSize: 0, inlineSize: 0 }] } as unknown as ResizeObserverEntry
    expect(native.options.measureElement(row, entry, native)).toBe(measured)
    expect(native.options.measureElement(row, undefined, native)).toBe(measured)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it.each(["end", "target"])("admits an initially inactive %s only on its first visible commit", target => {
    const positioned = vi.fn(), cancelled = vi.fn()
    const h = mount({ active: false, ...(target === "target" ? { scrollToMessageId: "m5" } : {}),
      onScrollTargetPositioned: positioned, onScrollTargetCancelled: cancelled })
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    act(() => vi.advanceTimersByTime(6500))
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(cancelled).not.toHaveBeenCalled()
    h.update({ active: true })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    if (target === "end") expect(end).toHaveBeenCalledOnce()
    else {
      expect(index).toHaveBeenCalled()
      expect(positioned).toHaveBeenCalledExactlyOnceWith("m5")
    }
  })

  it("admits a fresh entry staged while its retained pane is inactive", () => {
    const h = mount({ positionEntry: {}, initialPositionMessageId: "m4" })
    h.update({ active: false })
    h.update({ positionEntry: {}, initialPositionMessageId: "m10" })
    h.update({ active: true })
    expect(bodyTop(h.root, "m10")).toBeGreaterThan(0)
    expect(bodyTop(h.root, "m10")).toBeLessThan(h.root.clientHeight)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it.each(["end", "unread", "local", "target"])("positions a presented %s before commit without granting read or pagination", target => {
    const settled = vi.fn()
    const positioned = vi.fn()
    const h = mount({ active: false, positioningActive: true,
      ...(target === "unread" ? { newDividerBefore: "m5" }
        : target === "local" ? { initialPositionMessageId: "m5" }
        : target === "target" ? { scrollToMessageId: "m5" } : {}),
      onInitialPositionSettled: settled,
      onScrollTargetPositioned: positioned,
    })
    const native = scrollFixture.latest.virtualizer
    const end = vi.spyOn(native, "scrollToEnd")
    const index = vi.spyOn(native, "scrollToIndex")
    if (target === "end") expect(native.isAtEnd(1)).toBe(true)
    else {
      expect(bodyTop(h.root, "m5")).toBeGreaterThan(0)
      expect(bodyTop(h.root, "m5")).toBeLessThan(h.root.clientHeight)
    }
    expect(settled).toHaveBeenCalledOnce()
    if (target === "target") expect(positioned).toHaveBeenCalledExactlyOnceWith("m5")
    else expect(positioned).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(false)
    const offset = h.root.scrollTop
    h.update({ active: true })
    expect(h.root.scrollTop).toBe(offset)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(end).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
    expect(positioned).toHaveBeenCalledTimes(target === "target" ? 1 : 0)
  })

  it("keeps precommit user takeover after data and route commit arrive", () => {
    const settled = vi.fn()
    const h = mount({ active: false, positioningActive: true, initialScrollReady: false,
      onInitialPositionSettled: settled,
    })
    h.move(320)
    const offset = h.root.scrollTop
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    expect(settled).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ active: true, initialScrollReady: true })
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(offset)
    expect(settled).toHaveBeenCalledOnce()
  })

  it.each(["end", "unread", "local"])("waits beyond five seconds for data before choosing %s", target => {
    const h = mount({ initialScrollReady: false })
    const native = scrollFixture.latest.virtualizer
    const end = vi.spyOn(native, "scrollToEnd")
    const index = vi.spyOn(native, "scrollToIndex")
    act(() => vi.advanceTimersByTime(6500))
    runFrames()
    expect(end).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    h.update({ initialScrollReady: true,
      ...(target === "local" ? { initialPositionMessageId: "m5" } : target === "unread" ? { newDividerBefore: "m5" } : {}),
    })
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(end).toHaveBeenCalledTimes(target === "end" ? 1 : 0)
    if (target !== "end") expect(bodyTop(h.root, "m5")).toBeGreaterThan(0)
  })

  it("does not revive initial positioning when data resolves after user takeover", () => {
    const h = mount({ initialScrollReady: false })
    h.move(320)
    const before = h.root.scrollTop
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    h.update({ initialScrollReady: true })
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(before)
  })

  it("keeps an explicit loaded-tail Present in data wait until the current window qualifies", () => {
    const h = mount({ initialScrollReady: false })
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    act(() => scrollFixture.latest.scrollToBottom())
    act(() => vi.advanceTimersByTime(6500))
    expect(end).not.toHaveBeenCalled()
    h.update({ initialScrollReady: true })
    expect(end).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("retires a current data error without claiming a target success", () => {
    const positioned = vi.fn(), cancelled = vi.fn()
    const h = mount({ initialScrollReady: false, scrollToMessageId: "m5", onScrollTargetPositioned: positioned, onScrollTargetCancelled: cancelled })
    h.update({ positionDataState: "error" })
    expect(positioned).not.toHaveBeenCalled()
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("m5")
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it("finishes an authorized empty window without a scroll and follows its first append", () => {
    const positioned = vi.fn()
    const h = mount({ items: [], positionDataState: "empty", onScrollTargetPositioned: positioned })
    expect(scrollFixture.scrollCalls.every(value => value === 0)).toBe(true)
    expect(positioned).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h.update({ positionDataState: "ready", items: Array.from({ length: 14 }, (_, index) => message(`first-${index}`)) })
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
    expect(positioned).not.toHaveBeenCalled()
  })

  it("rejects movement made in an earlier RAF before its scroll event is delivered", () => {
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="scroll"]')!.scrollTo({ top: 280 }))
    const h = mount({}, false, undefined, undefined, 0)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    runFrames(1)
    expect(end).not.toHaveBeenCalled()
    runFrames()
    expect(h.root.scrollTop).toBe(280)
    expect(end).not.toHaveBeenCalled()
  })

  it.each([false, true])("bounds a qualified zero viewport once, including StrictMode=%s", strict => {
    scrollFixture.height = 0
    const h = mount({}, strict, undefined, undefined, 0)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    act(() => vi.advanceTimersByTime(4999))
    expect(scrollFixture.latest.paginationEnabled).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    scrollFixture.height = 500
    resize()
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it("bounds a qualified zero-width viewport without accepting a vertical-only landing", () => {
    scrollFixture.width = 0
    const h = mount({}, false, undefined, undefined, 0)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    runFrames(320)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    scrollFixture.width = 320
    resize()
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
  })

  it("gives a late native command only the remaining qualified budget", () => {
    scrollFixture.height = 0
    const h = mount({}, false, undefined, undefined, 0)
    act(() => vi.advanceTimersByTime(4800))
    scrollFixture.height = 500
    resize(0)
    vi.spyOn(h.root, "scrollTo").mockImplementation(() => {})
    const cancel = vi.spyOn(scrollFixture.latest.virtualizer, "cancelScroll")
    runFrames(1)
    act(() => vi.advanceTimersByTime(184))
    expect(cancel).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
  })

  it("retires hidden unfinished work and ignores all of its old frames on resume", () => {
    const h = mount({}, false, undefined, undefined, 0)
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    const frames = [...scrollFixture.frames.values()]
    h.stage({ active: false })
    h.stage({ active: true })
    act(() => frames.forEach(frame => frame(performance.now())))
    resize()
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it("retires pending work when the document becomes hidden", () => {
    const h = mount({}, false, undefined, undefined, 0)
    const visibility = vi.spyOn(document, "visibilityState", "get")
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    visibility.mockReturnValue("hidden")
    fireEvent(document, new Event("visibilitychange"))
    visibility.mockReturnValue("visible")
    fireEvent(document, new Event("visibilitychange"))
    resize()
    expect(end).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(0)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it("preserves the confirmed reader and native row measurements through hiding", () => {
    const h = mount()
    h.move(420)
    const before = h.root.scrollTop
    const native = scrollFixture.latest.virtualizer
    const row = h.root.querySelector<HTMLElement>('[data-msg-id="m5"]')!.closest<HTMLElement>('[data-index]')!
    const cachedSize = native.getVirtualItems().find(item => item.key === "msg:m5")!.size
    const end = vi.spyOn(native, "scrollToEnd"), index = vi.spyOn(native, "scrollToIndex")
    h.stage({ active: false })
    expect(native.options.useCachedMeasurements).toBe(true)
    const entry = { target: row, borderBoxSize: [{ blockSize: 0, inlineSize: 0 }] } as unknown as ResizeObserverEntry
    expect(native.options.measureElement(row, entry, native)).toBe(cachedSize)
    scrollFixture.height = 0
    resize()
    scrollFixture.height = 500
    h.stage({ active: true })
    resize()
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(end).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
  })

  it("uses current committed fetching conditions when an earlier geometry RAF executes", () => {
    const h = mount()
    const end = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToEnd")
    fireEvent.scroll(h.root)
    scrollFixture.width += 60
    h.stage({ isFetchingOlder: true })
    runFrames()
    expect(end).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("keeps resumed reading closed until the native viewport matches current geometry", () => {
    const h = mount()
    h.move(420)
    const before = h.root.scrollTop
    const native = scrollFixture.latest.virtualizer
    h.stage({ active: false })
    native.scrollRect = { width: 2, height: 2 }
    h.stage({ active: true })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.width += 1
    resize()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(h.root.scrollTop).toBe(before)
  })

  it.each(["error", "retired", "success"] as const)("finishes a Present query with %s without an intermediate fetching render", async status => {
    const previous = {}, next = {}
    const h = mount({ messageWindow: previous, hasMoreNewer: true })
    h.move(300)
    const before = h.root.scrollTop
    const pending = request()
    act(() => scrollFixture.latest.requestPresentPosition(pending.value))
    act(() => vi.advanceTimersByTime(6500))
    expect(scrollFixture.latest.paginationEnabled).toBe(false)
    await act(async () => pending.finish(status === "success" ? { status, window: next } : { status }))
    if (status === "success") h.update({ messageWindow: next, hasMoreNewer: false })
    else expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(status === "success")
  })

  it("finishes a Present request that commits an authorized empty window without scrolling", async () => {
    const previous = {}, next = {}
    const h = mount({ messageWindow: previous, hasMoreNewer: true })
    h.move(300)
    const pending = request()
    act(() => scrollFixture.latest.requestPresentPosition(pending.value))
    await act(async () => pending.finish({ status: "success", window: next }))
    const scroll = vi.spyOn(h.root, "scrollTo")
    h.update({ items: [], messageWindow: next, positionDataState: "empty", hasMoreNewer: false })
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scroll).not.toHaveBeenCalled()
    expect(h.root.querySelector("[data-msg-id]")).toBeNull()
  })

  it.each([null, { accepted: false } as const])("releases local submission when its Present request is not accepted: %s", presentRequest => {
    const h = mount({ hasMoreNewer: true, presentRequest: null })
    h.move(300)
    const before = h.root.scrollTop
    h.update({ localSubmitVersion: 1, presentRequest })
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(presentRequest !== null)
    expect(h.root.scrollTop).toBe(before)
  })

  it("does not let a superseded Present receipt consume a new target", async () => {
    const h = mount({ hasMoreNewer: true })
    const pending = request()
    act(() => scrollFixture.latest.requestPresentPosition(pending.value))
    h.update({ scrollToMessageId: "m4" })
    const before = h.root.scrollTop
    await act(async () => pending.finish({ status: "error" }))
    resize()
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("retires a Present result superseded by a different committed window", async () => {
    const previous = {}, expected = {}, replacement = {}
    const h = mount({ messageWindow: previous, hasMoreNewer: true })
    h.move(300)
    const before = h.root.scrollTop
    const pending = request()
    act(() => scrollFixture.latest.requestPresentPosition(pending.value))
    h.update({ messageWindow: replacement })
    await act(async () => pending.finish({ status: "success", window: expected }))
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(h.root.scrollTop).toBe(before)
  })

  it("releases a completed page whose canonical projection failed", async () => {
    const previous = {}, next = {}
    const h = mount({ messageWindow: previous })
    h.move(0)
    const before = h.root.scrollTop
    const pending = request()
    act(() => scrollFixture.latest.captureOlderPageAnchor()(pending.value))
    expect(scrollFixture.latest.paginationRequestPending).toBe(true)
    await act(async () => pending.finish({ status: "success", window: next }))
    h.update({ messageWindow: next, positionDataState: "error" })
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.virtualizer.options.anchorTo).toBe("start")
  })

  it.each(["error", "success"] as const)("binds local submission to its %s query result without a fetching render", async status => {
    const previous = {}, next = {}
    const h = mount({ messageWindow: previous, hasMoreNewer: true, presentRequest: null })
    h.move(300)
    const before = h.root.scrollTop
    const pending = request()
    h.update({ localSubmitVersion: 1, presentRequest: pending.value })
    await act(async () => pending.finish(status === "success" ? { status, window: next } : { status }))
    if (status === "success") h.update({ messageWindow: next, hasMoreNewer: false })
    else expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(scrollFixture.latest.readPositionReady).toBe(status === "success")
  })

  it.each(["rejected", "error", "retired", "empty", "prepend"])("finishes a %s page result without a fetching transition", async status => {
    const previous = {}, next = {}
    const h = mount({ messageWindow: previous })
    h.move(0)
    const before = bodyTop(h.root, "m0")
    const pending = request()
    act(() => scrollFixture.latest.captureOlderPageAnchor()(status === "rejected" ? { accepted: false } : pending.value))
    if (status !== "rejected") await act(async () => pending.finish(status === "error" || status === "retired" ? { status }
      : { status: "success", window: status === "empty" ? previous : next }))
    if (status === "prepend") h.update({ messageWindow: next, items: [message("older"), ...h.input.items] })
    else h.update({ items: [...h.input.items] })
    expect(scrollFixture.latest.virtualizer.options.anchorTo).toBe(status === "prepend" ? "end" : "start")
    expect(bodyTop(h.root, "m0")).toBeCloseTo(before, 0)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
})
