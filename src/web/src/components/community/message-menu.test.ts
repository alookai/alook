import { describe, it, expect, vi } from "vitest"
import { messageMenuItems, hasMessageMenu } from "./message-menu"

// The menu is contract-driven: each item appears ONLY when its handler is
// supplied, so a surface that can't drive an action omits it (no dead entries).
describe("messageMenuItems", () => {
  it("omits every item when no handlers are given", () => {
    expect(messageMenuItems({})).toEqual([])
    expect(hasMessageMenu({})).toBe(false)
  })

  it("includes 'Share as Image' only when onShare is provided", () => {
    expect(messageMenuItems({}).some((it) => it.label === "Share as Image")).toBe(false)
    const items = messageMenuItems({ onShare: () => {} })
    expect(items.some((it) => it.label === "Share as Image")).toBe(true)
  })

  it("wires the Share item's onClick to the provided handler", () => {
    const onShare = vi.fn()
    const share = messageMenuItems({ onShare }).find((it) => it.label === "Share as Image")
    share?.onClick?.()
    expect(onShare).toHaveBeenCalledOnce()
  })

  it("gives only the high-frequency actions (Reply, Share) an icon; the rest text-only", () => {
    // Locked spec (uiux #14): single list; icons only on Reply + Share as
    // navigation anchors; low-freq actions are text (icon slot → placeholder).
    const items = messageMenuItems({
      onReply: () => {}, onShare: () => {}, onAddReaction: () => {},
      onCreateThread: () => {}, onPin: () => {}, onCopy: () => {},
    })
    const iconLabels = items.filter((it) => it.icon).map((it) => it.label)
    expect(iconLabels).toEqual(["Reply", "Share as Image"])
    for (const label of ["Add Reaction", "Create Thread", "Pin Message", "Copy Text"]) {
      expect(items.find((it) => it.label === label)?.icon).toBeUndefined()
    }
  })

  it("keeps the original row order — icons don't reorder the list (uiux #19)", () => {
    const labels = messageMenuItems({
      onReply: () => {}, onShare: () => {}, onAddReaction: () => {},
      onCreateThread: () => {}, onPin: () => {}, onCopy: () => {},
    }).map((it) => it.label)
    expect(labels).toEqual(["Add Reaction", "Reply", "Create Thread", "Pin Message", "Copy Text", "Share as Image"])
    expect(labels).not.toContain("sep")
  })
})
