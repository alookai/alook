import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("current ready-window target retirement through the native position owner", () => {
  it.each(["local", "explicit"] as const)("cancels an absent %s target on ready without waiting for a viewport", kind => {
    scrollFixture.height = 0
    const settled = vi.fn(), cancelled = vi.fn(), positioned = vi.fn()
    const h = mount({ positionDataState: "pending", onInitialPositionSettled: settled,
      onScrollTargetCancelled: cancelled, onScrollTargetPositioned: positioned,
      ...(kind === "local" ? { initialPositionMessageId: "missing" } : { scrollToMessageId: "missing" }),
    })
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    act(() => vi.advanceTimersByTime(20000))
    expect(settled).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
    h.update({ positionDataState: "ready" })
    expect(scrollFixture.latest.positionOutcome).toBe("cancelled")
    expect(settled).toHaveBeenCalledExactlyOnceWith("cancelled")
    expect(cancelled.mock.calls).toEqual(kind === "explicit" ? [["missing"]] : [])
    expect(positioned).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.height = 500
    h.update({ items: [...h.input.items, message("missing")] })
    expect(index).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
    expect(positioned).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })

  it.each(["local", "explicit"] as const)("keeps an issued %s intent pending until its missing target becomes definitively ready", kind => {
    const settled = vi.fn(), cancelled = vi.fn(), positioned = vi.fn()
    const h = mount({ positionDataState: "ready", onInitialPositionSettled: settled,
      onScrollTargetCancelled: cancelled, onScrollTargetPositioned: positioned,
      ...(kind === "local" ? { initialPositionMessageId: "m4" } : { scrollToMessageId: "m4" }),
    }, false, undefined, undefined, 0)
    const native = scrollFixture.latest.virtualizer
    const index = vi.spyOn(native, "scrollToIndex").mockImplementation(() => {})
    const cancelScroll = vi.spyOn(native, "cancelScroll")
    runFrames(1)
    expect(index).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    const original = h.input.items
    h.update({ positionDataState: "pending", items: original.filter(item => item.kind !== "message" || item.m.id !== "m4") })
    act(() => vi.advanceTimersByTime(20000))
    expect(settled).not.toHaveBeenCalled()
    expect(cancelled).not.toHaveBeenCalled()
    expect(scrollFixture.frames.size).toBe(0)
    h.update({ positionDataState: "ready" })
    expect(settled).toHaveBeenCalledExactlyOnceWith("cancelled")
    expect(cancelScroll).toHaveBeenCalled()
    expect(cancelled.mock.calls).toEqual(kind === "explicit" ? [["m4"]] : [])
    expect(positioned).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    index.mockRestore()
    h.update({ items: original })
    expect(positioned).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ scrollToMessageId: "m10" })
    expect(positioned).toHaveBeenCalledExactlyOnceWith("m10")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(settled).toHaveBeenCalledOnce()
  })

  it.each(["local", "explicit"] as const)("lands a pending %s target when it arrives after twenty seconds", kind => {
    const settled = vi.fn(), positioned = vi.fn(), cancelled = vi.fn()
    const h = mount({ positionDataState: "pending", onInitialPositionSettled: settled,
      onScrollTargetPositioned: positioned, onScrollTargetCancelled: cancelled,
      ...(kind === "local" ? { initialPositionMessageId: "missing" } : { scrollToMessageId: "missing" }),
    })
    act(() => vi.advanceTimersByTime(20000))
    expect(scrollFixture.frames.size).toBe(0)
    expect(settled).not.toHaveBeenCalled()
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    h.update({ positionDataState: "ready", items: [...h.input.items, message("missing")] })
    expect(index).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledExactlyOnceWith("success")
    expect(cancelled).not.toHaveBeenCalled()
    expect(positioned.mock.calls).toEqual(kind === "explicit" ? [["missing"]] : [])
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("cancels an ordinary read target removed before its command is issued", () => {
    const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
    const settled = vi.fn()
    const h = mount({ items, initialPositionMessageId: "m5", onInitialPositionSettled: settled }, false, undefined, undefined, 0)
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    h.update({ positionDataState: "ready", items: items.filter(item => item.key !== "msg:m5") })
    expect(index).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledExactlyOnceWith("cancelled")
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    h.update({ items })
    expect(index).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })
})
