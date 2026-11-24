import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import {
  bodyTop,
  installMessageScrollFixture,
  message,
  mount,
  resize,
  restoreMessageScrollFixture,
  runFrames,
  scrollFixture,
} from "@/test/message-scroll-fixture"
import type { MessageRequestResult, NewPositionRequest } from "@/lib/community/message-position"
import type { useConversationScroll } from "./use-conversation-scroll"

type BoundaryReached = NonNullable<Parameters<typeof useConversationScroll>[0]["onNewBoundaryReached"]>

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("useConversationScroll", () => {
  it("anchors short lists at the bottom via mt-auto and snaps tall lists to bottom instantaneously before paint", () => {
    const short = mount({ items: [message("m1"), message("m2")] })
    expect(short.root.scrollTop).toBe(0)
    expect(short.root.scrollHeight).toBe(short.root.clientHeight)
    const rowsEl = short.root.querySelector<HTMLElement>("[data-message-rows]")!
    expect(rowsEl).toHaveClass("mt-auto")
    expect(rowsEl.getBoundingClientRect().top).toBeGreaterThan(0)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.followingTail).toBe(true)
    short.view.unmount()

    const tall = mount()
    expect(tall.root.scrollHeight).toBeGreaterThan(tall.root.clientHeight)
    expect(tall.root.scrollTop).toBe(tall.root.scrollHeight - tall.root.clientHeight)
    expect(tall.root.querySelector<HTMLElement>("[data-message-rows]")!.getBoundingClientRect().top).toBeLessThan(0)
    expect(scrollFixture.latest.belowCount).toBe(0)
    expect(scrollFixture.latest.readingTail).toBe(true)
    tall.view.unmount()
  })

  it("smoothly follows live peer appends when pinned and respects prefers-reduced-motion", () => {
    let reduced = false
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList)
    const behaviors: Array<ScrollBehavior | undefined> = []
    const originalScrollTo = HTMLElement.prototype.scrollTo
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === "object" && options) behaviors.push(options.behavior)
      return Reflect.apply(originalScrollTo, this, [options])
    })

    const h = mount()
    behaviors.length = 0
    h.update({ items: [...h.input.items, message("live-1")] })
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
    expect(behaviors.at(-1)).toBe("smooth")

    reduced = true
    h.update({ items: [...h.input.items, message("live-2")] })
    expect(h.root.scrollTop).toBe(h.root.scrollHeight - h.root.clientHeight)
    expect(behaviors.at(-1)).toBe("auto")
    matchMedia.mockRestore()
    h.view.unmount()
  })

  it("preserves exact reading anchor synchronously across older prepends, above-fold row growth, and viewport resizes (WebKit-safe)", () => {
    const onTakeover = vi.fn()
    const h = mount({ onUserTakeover: onTakeover })
    h.move(400)
    expect(onTakeover).toHaveBeenCalled()
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.belowCount).toBeGreaterThan(0)

    const visible = Array.from(h.root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((el) => el.getBoundingClientRect().bottom > 1)!
    const anchorId = visible.dataset.msgId!
    const beforeTop = bodyTop(h.root, anchorId)

    h.update({
      items: [message("old-1"), message("old-2"), message("old-3"), ...h.input.items],
    })
    expect(Math.abs(bodyTop(h.root, anchorId) - beforeTop)).toBeLessThanOrEqual(1)

    scrollFixture.bodyHeights.set("old-1", 260)
    resize()
    expect(Math.abs(bodyTop(h.root, anchorId) - beforeTop)).toBeLessThanOrEqual(1)

    const topBeforePeer = h.root.scrollTop
    h.update({ items: [...h.input.items, message("peer-while-reading")] })
    expect(h.root.scrollTop).toBe(topBeforePeer)
    expect(scrollFixture.latest.followingTail).toBe(false)
    h.view.unmount()
  })

  it("handles tall-tail belowCount === 0 recovery without revoking active upward takeover (#359)", () => {
    scrollFixture.bodyHeights.set("m13", 1200)
    const h = mount()
    h.move(h.root.scrollHeight - h.root.clientHeight - 600)
    expect(scrollFixture.latest.belowCount).toBe(0)
    expect(scrollFixture.latest.followingTail).toBe(false)

    fireEvent.wheel(h.root, { deltaY: 20 })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(true)
    expect(scrollFixture.latest.readingTail).toBe(false)

    const before = h.root.scrollTop
    scrollFixture.height -= 160
    resize()
    expect(h.root.scrollTop).toBe(before + 160)
    expect(scrollFixture.latest.followingTail).toBe(true)

    fireEvent.wheel(h.root, { deltaY: -20 })
    act(() => h.root.scrollTo({ top: h.root.scrollTop - 20 }))
    runFrames()
    expect(scrollFixture.latest.belowCount).toBe(0)
    expect(scrollFixture.latest.followingTail).toBe(false)
    const detachedTop = h.root.scrollTop
    h.update({ items: [...h.input.items, message("peer-detached")] })
    expect(h.root.scrollTop).toBe(detachedTop)
    h.view.unmount()
  })

  it("keeps unloaded newer pages detached and exposes jumpToPresentVisible", () => {
    scrollFixture.bodyHeights.set("m13", 1200)
    const h = mount({ hasMoreNewer: true })
    h.move(h.root.scrollHeight - h.root.clientHeight - 600)
    fireEvent.wheel(h.root, { deltaY: 20 })
    runFrames()
    expect(scrollFixture.latest.belowCount).toBe(0)
    expect(scrollFixture.latest.jumpToPresentVisible).toBe(true)
    expect(scrollFixture.latest.followingTail).toBe(false)
    h.view.unmount()
  })

  it("qualifies New boundary consumption only from manual scroll or explicit present jump", async () => {
    const reached = vi.fn<BoundaryReached>()
    const entry = {}
    const owner = {}
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 39 }))

    const h1 = mount({ items: rows, newDividerBefore: "m39", positionEntry: entry, newBoundaryOwner: owner, onNewBoundaryReached: reached })
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(reached).not.toHaveBeenCalled()
    h1.update({ items: [...rows, message("passive-append")] })
    expect(reached).not.toHaveBeenCalled()
    h1.view.unmount()

    const h2 = mount({ items: rows, newDividerBefore: "m39", initialPositionMessageId: "m0", positionEntry: entry, newBoundaryOwner: owner, onNewBoundaryReached: reached })
    expect(scrollFixture.latest.newDividerVisibility).toBe("below")
    act(() => scrollFixture.latest.scrollToBottom())
    resize()
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(reached).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "m39", entry, owner }))
    h2.view.unmount()

    const aboveRows = Array.from({ length: 40 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 5 }))
    const h3 = mount({ items: aboveRows, newDividerBefore: "m5" })
    expect(scrollFixture.latest.newDividerVisibility).toBe("above")
    let request!: NewPositionRequest
    act(() => { request = scrollFixture.latest.requestNewPosition("m5") })
    expect(request.accepted).toBe(true)
    resize()
    if (request.accepted) {
      await expect(request.completed).resolves.toBe("success")
    }
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    h3.view.unmount()
  })

  it("supports scrollToMessageId, user cancellation, and foreground resume from hidden", async () => {
    const onPositioned = vi.fn()
    const onCancelled = vi.fn()
    const h = mount({
      items: Array.from({ length: 30 }, (_, i) => message(`m${i}`)),
      scrollToMessageId: "m5",
      positionDataState: "pending",
      targetPositionDataState: "pending",
      onScrollTargetPositioned: onPositioned,
      onScrollTargetCancelled: onCancelled,
    })
    expect(onPositioned).not.toHaveBeenCalled()
    fireEvent.wheel(h.root, { deltaY: -20 })
    expect(onCancelled).toHaveBeenCalledWith("m5")
    h.view.unmount()

    const h2 = mount()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h2.update({ active: false })
    h2.update({ items: [...h2.input.items, message("hidden-peer")] })
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h2.update({ active: true })
    expect(h2.root.scrollTop).toBe(h2.root.scrollHeight - h2.root.clientHeight)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    h2.view.unmount()
  })

  it("serializes pagination anchors through MessageRequest completion and reports reading message", async () => {
    const reading = vi.fn()
    const beforeWindow = {}
    const nextWindow = {}
    const h = mount({ messageWindow: beforeWindow, onReadingMessage: reading })
    expect(reading).toHaveBeenCalled()
    h.move(200)

    let complete!: (result: MessageRequestResult) => void
    const completed = new Promise<MessageRequestResult>((resolve) => { complete = resolve })
    let receive!: false | ((req: { accepted: true; completed: Promise<MessageRequestResult> }) => void)
    act(() => { receive = h.input.items.length > 0 ? scrollFixture.latest.captureOlderPageAnchor() : false })
    expect(receive).toBeTypeOf("function")
    expect(scrollFixture.latest.paginationRequestPending).toBe(true)
    act(() => { if (typeof receive === "function") receive({ accepted: true, completed }) })

    const beforeTop = bodyTop(h.root, "m2")
    await act(async () => { complete({ status: "success", window: nextWindow }); await completed })
    h.update({
      items: [message("p1"), message("p2"), message("p3"), ...h.input.items],
      messageWindow: nextWindow,
    })
    expect(Math.abs(bodyTop(h.root, "m2") - beforeTop)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.paginationRequestPending).toBe(false)
    h.view.unmount()
  })

  it("keeps smooth tail-append scroll pinned across intermediate frames without self-cancelling", () => {
    const matchMedia = window.matchMedia.bind(window)
    const preference = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query)
      return query === "(prefers-reduced-motion: reduce)" ? { ...result, matches: false } : result
    })
    const h = mount()
    try {
      expect(scrollFixture.latest.followingTail).toBe(true)

      const originalScrollTo = h.root.scrollTo
      const smoothCalls: ScrollToOptions[] = []
      Object.defineProperty(h.root, "scrollTo", {
        configurable: true,
        value(options: ScrollToOptions) {
          smoothCalls.push(options)
          if (options.behavior === "smooth") {
            const target = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight))
            this.scrollTop = Math.max(this.scrollTop, target - 120)
            this.dispatchEvent(new Event("scroll"))
            return
          }
          originalScrollTo.call(this, options)
        },
      })

      scrollFixture.bodyHeights.set("tall-append", 260)
      h.update({ items: [...h.input.items, message("tall-append")] })
      expect(smoothCalls).toHaveLength(1)
      expect(smoothCalls[0].behavior).toBe("smooth")
      expect(scrollFixture.latest.followingTail).toBe(true)

      act(() => {
        h.root.scrollTop = h.root.scrollHeight - h.root.clientHeight - 50
        h.root.dispatchEvent(new Event("scroll"))
      })
      expect(scrollFixture.latest.followingTail).toBe(true)

      act(() => {
        h.root.scrollTop = h.root.scrollHeight - h.root.clientHeight
        h.root.dispatchEvent(new Event("scroll"))
      })
      runFrames()
      expect(scrollFixture.latest.followingTail).toBe(true)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
    } finally {
      h.view.unmount()
      preference.mockRestore()
    }
  })

  it("does not restart smooth scrollToBottom on intermediate scroll frames", () => {
    const matchMedia = window.matchMedia.bind(window)
    const preference = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query)
      return query === "(prefers-reduced-motion: reduce)" ? { ...result, matches: false } : result
    })
    const h = mount()
    try {
      h.move(200)
      expect(scrollFixture.latest.followingTail).toBe(false)

      const smoothCalls: ScrollToOptions[] = []
      Object.defineProperty(h.root, "scrollTo", {
        configurable: true,
        value(options: ScrollToOptions) {
          smoothCalls.push(options)
        },
      })

      act(() => { scrollFixture.latest.scrollToBottom() })
      expect(smoothCalls).toHaveLength(1)
      expect(smoothCalls[0].behavior).toBe("smooth")

      const max = h.root.scrollHeight - h.root.clientHeight
      act(() => {
        h.root.scrollTop = Math.round((200 + max) / 2)
        h.root.dispatchEvent(new Event("scroll"))
      })
      expect(smoothCalls).toHaveLength(1)

      act(() => {
        h.root.scrollTop = max
        h.root.dispatchEvent(new Event("scroll"))
      })
      runFrames()
      expect(smoothCalls).toHaveLength(1)
      expect(scrollFixture.latest.followingTail).toBe(true)
      expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(0)
    } finally {
      h.view.unmount()
      preference.mockRestore()
    }
  })

  it("retains pinned follow after clamped click and downward inputs at bottom", () => {
    const h = mount()
    expect(scrollFixture.latest.followingTail).toBe(true)

    fireEvent.pointerDown(h.root, { pointerId: 1 })
    fireEvent.pointerUp(document, { pointerId: 1 })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(true)

    for (const action of [
      () => fireEvent.wheel(h.root, { deltaY: 120 }),
      () => fireEvent.keyDown(h.root, { key: "ArrowDown" }),
      () => fireEvent.keyDown(h.root, { key: "PageDown" }),
      () => fireEvent.keyDown(h.root, { key: "End" }),
      () => fireEvent.keyDown(h.root, { key: " " }),
    ]) {
      action()
      runFrames()
      expect(scrollFixture.latest.followingTail).toBe(true)
    }

    h.update({ items: [...h.input.items, message("after-clamped-input")] })
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    h.view.unmount()
  })

  it("follows passive appends within CONVERSATION_TAIL_SPACE_PX and preserves distance=2 on viewport resize", () => {
    const h = mount()
    const max = h.root.scrollHeight - h.root.clientHeight
    act(() => {
      h.root.scrollTop = max - 2
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(true)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)

    scrollFixture.height += 120
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)

    scrollFixture.height -= 120
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBe(2)

    h.update({ items: [...h.input.items, message("passive-within-tail")] })
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)

    const nextMax = h.root.scrollHeight - h.root.clientHeight
    act(() => {
      h.root.scrollTop = nextMax - 40
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(true)

    act(() => {
      h.root.scrollTop = nextMax - 41
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames()
    expect(scrollFixture.latest.followingTail).toBe(false)
    const beforeAwayTop = h.root.scrollTop
    scrollFixture.height += 120
    resize()
    const expectedClampedTop = Math.min(beforeAwayTop, Math.max(0, h.root.scrollHeight - h.root.clientHeight))
    expect(Math.abs(h.root.scrollTop - expectedClampedTop)).toBeLessThanOrEqual(1)
    scrollFixture.height -= 120
    resize()
    expect(Math.abs(h.root.scrollTop - expectedClampedTop)).toBeLessThanOrEqual(1)

    h.update({ items: [...h.input.items, message("passive-beyond-tail")] })
    expect(Math.abs(h.root.scrollTop - expectedClampedTop)).toBeLessThanOrEqual(1)
    h.view.unmount()
  })

  it("clamps cleanly to tail when viewport expands after scrollToNew and preserves New reading near tail until local submit", async () => {
    scrollFixture.height = 300
    const rows = Array.from({ length: 23 }, (_, i) => ({ ...message(`m${i}`), newDivider: i === 18 }))
    const h = mount({ items: rows, newDividerBefore: "m18" })
    expect(scrollFixture.latest.newDividerVisibility).toBe("above")

    let req!: NewPositionRequest
    act(() => { req = scrollFixture.latest.requestNewPosition("m18") })
    resize()
    if (req.accepted) await expect(req.completed).resolves.toBe("success")

    scrollFixture.height = 800
    resize()
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)

    const max = h.root.scrollHeight - h.root.clientHeight
    act(() => {
      h.root.scrollTop = max - 20
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames()
    const beforePeerTop = h.root.scrollTop
    h.update({ items: [...rows, message("peer-near-new")] })
    expect(h.root.scrollTop).toBe(beforePeerTop)

    h.update({ items: [...rows, message("peer-near-new"), message("local-submit")], localSubmitVersion: 1 })
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    h.view.unmount()
  })

  it("clears retired older viewport-fill suppression after user scroll reports a new reading message", async () => {
    const reading = vi.fn()
    const beforeWindow = { tag: "before" }
    const h = mount({ messageWindow: beforeWindow, onReadingMessage: reading })
    let resolveFill!: (result: { status: "retired" }) => void
    const fillCompleted = new Promise<{ status: "retired" }>((resolve) => { resolveFill = resolve })

    act(() => {
      const receive = scrollFixture.latest.captureOlderPageAnchor(true)
      expect(typeof receive).toBe("function")
      if (typeof receive === "function") receive({ accepted: true, completed: fillCompleted })
    })
    await act(async () => {
      resolveFill({ status: "retired" })
      await fillCompleted
    })
    runFrames()

    expect(scrollFixture.latest.captureOlderPageAnchor(false)).toBe(false)

    act(() => {
      h.root.scrollTop = 0
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames()

    expect(reading).toHaveBeenCalledWith("m0")
    expect(typeof scrollFixture.latest.captureOlderPageAnchor(false)).toBe("function")
    h.view.unmount()
  })

  it("upgrades initialPositionMessageId jump to notifyTarget when scrollToMessageId becomes ready", () => {
    const onPositioned = vi.fn()
    const rows = Array.from({ length: 30 }, (_, i) => message(`m${i}`))
    const h = mount({
      items: rows,
      initialScrollReady: true,
      positionDataState: "pending",
      targetPositionDataState: "pending",
      initialPositionMessageId: "m10",
      scrollToMessageId: "m10",
      onScrollTargetPositioned: onPositioned,
    })

    expect(onPositioned).not.toHaveBeenCalled()

    h.update({
      positionDataState: "ready",
      targetPositionDataState: "ready",
    })
    runFrames()

    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(onPositioned).toHaveBeenCalledWith("m10")
    h.view.unmount()
  })

  it("avoids redundant React re-renders on steady-state history scrolls and keeps paginationScroller items stable on 150 rows", () => {
    const rows = Array.from({ length: 150 }, (_, i) => message(`m${i}`))
    let renders = 0
    const h = mount({ items: rows }, false, () => { renders += 1 })
    const initialVirtual = scrollFixture.latest.paginationScroller.getVirtualItems()
    expect(initialVirtual).toHaveLength(151)
    expect(scrollFixture.latest.paginationScroller.getVirtualItems()).toBe(initialVirtual)

    h.move(5000)
    expect(scrollFixture.latest.followingTail).toBe(false)
    const belowAt5000 = scrollFixture.latest.belowCount
    expect(belowAt5000).toBeGreaterThan(50)

    const rendersBeforeMicroScroll = renders
    act(() => {
      h.root.scrollTop = 5010
      h.root.dispatchEvent(new Event("scroll"))
    })
    runFrames(4)
    expect(scrollFixture.latest.belowCount).toBe(belowAt5000)
    expect(renders).toBe(rendersBeforeMicroScroll)
    expect(scrollFixture.latest.paginationScroller.getVirtualItems()).toBe(initialVirtual)

    const visible = Array.from(h.root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((el) => el.getBoundingClientRect().bottom > 1)!
    const anchorId = visible.dataset.msgId!
    const beforeTop = bodyTop(h.root, anchorId)
    h.update({ items: [message("old-a"), message("old-b"), ...rows] })
    expect(Math.abs(bodyTop(h.root, anchorId) - beforeTop)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.paginationScroller.getVirtualItems()).not.toBe(initialVirtual)
    h.view.unmount()
  })

  it("compensates above-anchor height growth even while a pointer drag is active", () => {
    const h = mount()
    h.move(500)
    expect(scrollFixture.latest.followingTail).toBe(false)
    const beforeTop = bodyTop(h.root, "m5")
    const beforeScrollTop = h.root.scrollTop

    fireEvent.pointerDown(h.root, { pointerId: 9 })
    scrollFixture.bodyHeights.set("m1", 340)
    resize()

    expect(h.root.scrollTop).toBeGreaterThan(beforeScrollTop + 200)
    expect(Math.abs(bodyTop(h.root, "m5") - beforeTop)).toBeLessThanOrEqual(1)
    fireEvent.pointerUp(document, { pointerId: 9 })
    h.view.unmount()
  })
})
