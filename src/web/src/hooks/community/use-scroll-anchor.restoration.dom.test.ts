import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken } from "@/lib/community/conversation-qualification"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("ordinary reconstruction and one-shot late unread ownership", () => {
  it.each([false, true])("uses normal entry rules after deep browsing (StrictMode=%s)", async strict => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "A"), tag: null }
    const items = Array.from({ length: 180 }, (_, index) => message(`m${index}`))
    for (const source of ["tail", "read", "new", "explicit"] as const) {
      const original = mount({ positionScope, items }, strict)
      original.move(1800)
      const offset = original.root.scrollTop
      expect(offset).toBe(1800)
      original.view.unmount()
      const returned = mount({ positionScope, items,
        ...(source === "read" || source === "explicit" ? { initialPositionMessageId: "m120" } : {}),
        ...(source === "new" || source === "explicit" ? { newDividerBefore: "m100" } : {}),
        ...(source === "explicit" ? { scrollToMessageId: "m80" } : {}),
      }, strict)
      const native = scrollFixture.latest.virtualizer
      expect(returned.root.scrollTop).not.toBe(offset)
      if (source === "tail") expect(returned.root.scrollHeight - returned.root.clientHeight - returned.root.scrollTop).toBeLessThanOrEqual(1)
      else {
        const id = source === "read" ? "m120" : source === "new" ? "m100" : "m80"
        const index = native.getVirtualItems().find(row => row.key === `msg:${id}`)!.index
        expect(returned.root.scrollTop).toBeCloseTo(native.getOffsetForIndex(index, "center")![0], 0)
      }
      expect(scrollFixture.latest.positionOutcome).toBe("success")
      expect(scrollFixture.latest.readPositionReady).toBe(true)
      returned.view.unmount()
    }
  })

  it.each([false, true])("waits for cached rows and uses the qualified read target on reconstruction (StrictMode=%s)", async strict => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "A"), tag: null }
    const items = Array.from({ length: 180 }, (_, index) => message(`m${index}`))
    const first = mount({ positionScope, items }, strict)
    first.move(1800)
    first.view.unmount()
    const returned = mount({ positionScope, items: [], initialScrollReady: false, positionDataState: "pending" }, strict)
    expect(scrollFixture.latest.positionOutcome).toBe("pending")
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    returned.update({ items, initialPositionMessageId: "m120", initialScrollReady: true, positionDataState: "ready" })
    const native = scrollFixture.latest.virtualizer
    const index = native.getVirtualItems().find(row => row.key === "msg:m120")!.index
    expect(returned.root.scrollTop).toBeCloseTo(native.getOffsetForIndex(index, "center")![0], 0)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("does not mount the whole cached history in the first committed viewport", () => {
    let firstCount: number | undefined
    const h = mount({ items: Array.from({ length: 180 }, (_, index) => message(`m${index}`)) }, false,
      () => { firstCount ??= document.querySelectorAll('[data-testid="scroll"] [data-index]').length }, undefined, 0)
    expect(firstCount).toBeGreaterThan(0)
    expect(firstCount).toBeLessThan(60)
    resize()
    expect(h.root.querySelectorAll('[data-index]').length).toBeLessThan(60)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
  })

  it("settles an ordinary read target whose row has overflowing content", () => {
    scrollFixture.bodyHeights.set("m120", 400)
    scrollFixture.overflowHeights.set("m120", 967)
    const h = mount({ items: Array.from({ length: 180 }, (_, index) => message(`m${index}`)), initialPositionMessageId: "m120" })
    const row = h.root.querySelector<HTMLElement>('[data-msg-id="m120"]')!.closest<HTMLElement>('[data-index]')!
    expect(row.getBoundingClientRect().height).toBe(400)
    expect(row.scrollHeight).toBe(967)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it.each([
    { source: "tail", overflow: 967 },
    { source: "read", overflow: 2000 },
    { source: "target", overflow: 2000 },
    { source: "new", overflow: 2000 },
    { source: "new-fallback", overflow: 2000 },
  ] as const)("settles $source using actual overflowing content within its native landing", ({ source, overflow }) => {
    const id = source === "tail" ? "m179" : "m120"
    scrollFixture.bodyHeights.set(id, 400)
    scrollFixture.overflowHeights.set(id, overflow)
    const items = Array.from({ length: 180 }, (_, index) => ({ ...message(`m${index}`),
      ...(source === "new" && index === 120 ? { newDivider: true } : {}),
    }))
    const h = mount({ items,
      ...(source === "read" ? { initialPositionMessageId: id } : {}),
      ...(source === "target" ? { scrollToMessageId: id } : {}),
      ...(source === "new" || source === "new-fallback" ? { newDividerBefore: id } : {}),
    })
    const body = h.root.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!
    const rect = body.getBoundingClientRect()
    expect(h.root.clientHeight).toBe(500)
    expect(rect.height).toBe(400)
    expect(body.scrollHeight).toBe(overflow)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    const native = scrollFixture.latest.virtualizer
    if (source === "tail") expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    else {
      const key = source === "new" ? "divider:msg:m120" : `msg:${id}`
      const index = native.getVirtualItems().find(item => item.key === key)!.index
      expect(h.root.scrollTop).toBeCloseTo(native.getOffsetForIndex(index, "center")![0], 0)
    }
    expect(rect.top).toBeLessThan(500)
    expect(rect.top + body.scrollHeight).toBeGreaterThan(0)
    if (source === "new") {
      const marker = h.root.querySelector<HTMLElement>('[data-new-divider]')!.getBoundingClientRect()
      expect(marker.top).toBeGreaterThanOrEqual(0)
      expect(marker.bottom).toBeLessThanOrEqual(500)
    }
  })

  it("does not accept clipped offscreen content as a visible target", () => {
    scrollFixture.bodyHeights.set("m120", 400)
    scrollFixture.overflowHeights.set("m120", 2000)
    scrollFixture.overflowModes.set("m120", "hidden")
    const h = mount({ items: Array.from({ length: 180 }, (_, index) => message(`m${index}`)), initialPositionMessageId: "m120" })
    const body = h.root.querySelector<HTMLElement>('[data-msg-id="m120"]')!
    expect(body.getBoundingClientRect().bottom).toBeLessThan(0)
    expect(scrollFixture.latest.positionOutcome).toBe("pending")
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.overflowModes.set("m120", "visible")
    h.update({ items: [...h.input.items] })
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("keeps manual takeover when delayed cached data becomes ready", async () => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "A"), tag: null }
    const items = Array.from({ length: 180 }, (_, index) => message(`m${index}`))
    const first = mount({ positionScope, items })
    first.move(1800)
    first.view.unmount()
    const returned = mount({ positionScope, items: [], initialScrollReady: false, positionDataState: "pending" })
    const jump = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    fireEvent.wheel(returned.root, { deltaY: -10 })
    returned.update({ items, initialPositionMessageId: "m120", initialScrollReady: true, positionDataState: "pending" })
    expect(jump).not.toHaveBeenCalled()
    expect(scrollFixture.latest.positionOutcome).toBe("user-cancelled")
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    returned.update({ positionDataState: "ready" })
    expect(jump).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("centers the first late NEW once while data is pending and never restarts it for later boundaries", () => {
    const h = mount({ initialPositionMessageId: "m4", positionDataState: "pending" })
    const native = scrollFixture.latest.virtualizer
    const index = vi.spyOn(native, "scrollToIndex")
    h.update({ newDividerBefore: "m8" })
    expect(index).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    const before = h.root.scrollTop
    h.update({ newDividerBefore: "m10" })
    expect(index).toHaveBeenCalledOnce()
    expect(h.root.scrollTop).toBe(before)
    h.update({ positionDataState: "ready" })
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it("keeps the first late NEW eligible beyond five seconds and waits for a real viewport without polling", () => {
    scrollFixture.height = 0
    const shown = vi.fn()
    const h = mount({ onInitialPositionSettled: shown }, false, undefined, undefined, 0)
    runFrames(2)
    act(() => vi.advanceTimersByTime(20000))
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    h.stage({ items: h.input.items.map((item, offset) => ({ ...item, newDivider: offset === 8 })), newDividerBefore: "m8" })
    runFrames(2)
    expect(scrollFixture.frames.size).toBe(0)
    expect(shown).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.height = 500
    resize()
    expect(index).toHaveBeenCalledOnce()
    const marker = h.root.querySelector("[data-new-divider]")!.getBoundingClientRect()
    expect((marker.top + marker.bottom) / 2).toBeCloseTo(250, 0)
    expect(shown).toHaveBeenCalledOnce()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it.each(["user", "explicit", "present", "leave", "error"] as const)("rejects a late NEW after %s retires its automatic eligibility", mode => {
    const h = mount()
    if (mode === "user") fireEvent.wheel(h.root, { deltaY: -30 })
    if (mode === "explicit") h.update({ scrollToMessageId: "m4" })
    if (mode === "present") act(() => scrollFixture.latest.scrollToBottom())
    if (mode === "leave") { h.update({ active: false }); h.update({ active: true }) }
    if (mode === "error") { h.update({ positionDataState: "error" }); h.update({ positionDataState: "ready" }) }
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    const before = h.root.scrollTop
    h.update({ newDividerBefore: "m8" })
    expect(index).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(before)
  })

  it("retires a NEW withdrawn before its layout commits instead of centering a different message", () => {
    const h = mount({ initialPositionMessageId: "m4" })
    const index = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToIndex")
    const before = h.root.scrollTop
    h.stage({ newDividerBefore: "m8" })
    h.stage({ newDividerBefore: "m10" })
    resize()
    expect(index).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(before)
  })

  it("gives a late NEW priority over native append following before issuing either command", () => {
    const h = mount()
    const native = scrollFixture.latest.virtualizer
    const end = vi.spyOn(native, "scrollToEnd"), index = vi.spyOn(native, "scrollToIndex")
    h.stage({ items: [...h.input.items, { ...message("m14"), newDivider: true }, message("m15")], newDividerBefore: "m14" })
    expect(native.options.followOnAppend).toBe(false)
    expect(end).not.toHaveBeenCalled()
    resize()
    expect(index).toHaveBeenCalledOnce()
    expect(end).not.toHaveBeenCalled()
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
})
