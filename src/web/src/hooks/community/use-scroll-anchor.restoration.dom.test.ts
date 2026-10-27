import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken } from "@/lib/community/conversation-qualification"
import { virtualListPositionKey, type VirtualListPositionScope, type VirtualListPositionSnapshot } from "@/lib/community/virtual-list-position"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

describe("native snapshot restoration and one-shot late unread ownership", () => {
  it.each([false, true])("keeps the saved body offset when prepend changes an unsettled restore index (StrictMode=%s)", async strict => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: VirtualListPositionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages", tag: null }
    const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
    const original = mount({ positionScope, items }, strict)
    original.move(800)
    const snapshot = client.getQueryData<VirtualListPositionSnapshot>(virtualListPositionKey(positionScope))!
    const anchorId = String(snapshot.anchorKey).slice(4)
    const top = bodyTop(original.root, anchorId)
    original.view.unmount()
    const restored = mount({ positionScope, items }, strict, undefined, undefined, 0)
    scrollFixture.bodyHeights.set(anchorId, 0)
    resize(1)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    expect(scrollFixture.latest.positionOutcome).toBe("pending")
    restored.stage({ items: [message("prepended"), ...items] })
    runFrames(1)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
    scrollFixture.bodyHeights.set(anchorId, 100)
    resize()
    expect(bodyTop(restored.root, anchorId)).toBeCloseTo(top, 0)
    expect(restored.root.querySelector(`[data-msg-id="${anchorId}"]`)!.closest<HTMLElement>("[data-message-row-key]")!.dataset.messageRowKey).toBe(snapshot.anchorKey)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })
  it.each([false, true])("restores a destroyed instance from its own measured snapshot (StrictMode=%s)", async strict => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: VirtualListPositionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages", tag: null }
    const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
    const h = mount({ positionScope, items }, strict)
    h.move(800)
    resize()
    const before = h.root.scrollTop
    const snapshot = client.getQueryData<VirtualListPositionSnapshot>(virtualListPositionKey(positionScope))
    expect(snapshot?.offset).toBe(before)
    expect(snapshot!.measurements.length).toBeGreaterThan(0)
    h.view.unmount()
    const restored = mount({ positionScope, items }, strict)
    expect(scrollFixture.latest.virtualizer.options.initialMeasurementsCache.length).toBeGreaterThan(0)
    expect(scrollFixture.latest.virtualizer.options.initialOffset).toBe(before)
    expect(restored.root.scrollTop).toBeCloseTo(before, 0)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  })

  it.each(["other-channel", "other-account", "changed-rows", "changed-width", "explicit-target"] as const)("does not restore stale pixels for %s", async mode => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: VirtualListPositionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages", tag: null }
    const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
    const h = mount({ positionScope, items })
    h.move(600)
    resize()
    h.view.unmount()
    const otherClient = mode === "other-account" ? (await createCommunityQueryOwner("other")).client : client
    const scope = mode === "other-channel" || mode === "other-account"
      ? { ...positionScope, proof: captureChannelMetadataToken(otherClient, mode === "other-channel" ? "B" : "A") } : positionScope
    if (mode === "changed-width") scrollFixture.width = 600
    const restored = mount({ positionScope: scope,
      items: mode === "changed-rows" ? items.map((item, index) => index === 1 ? { ...item, m: { ...item.m, content: "Edited body" } } : item) : items,
      ...(mode === "explicit-target" ? { scrollToMessageId: "m5" } : {}),
    })
    const native = scrollFixture.latest.virtualizer
    if (mode === "explicit-target") {
      const index = native.getVirtualItems().find(row => row.key === "msg:m5")!.index
      expect(restored.root.scrollTop).toBeCloseTo(native.getOffsetForIndex(index, "center")![0], 0)
    } else expect(restored.root.scrollHeight - restored.root.clientHeight - restored.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.positionOutcome).toBe("success")
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
