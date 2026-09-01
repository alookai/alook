import { describe, it, expect, vi } from "vitest"
import { messageLinkMenuItems, messageMenuItems, hasMessageMenu } from "./message-menu"

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

  it("keeps Edit Message hidden even when the author-scoped handler is provided", () => {
    expect(messageMenuItems({}).some((it) => it.label === "Edit Message")).toBe(false)
    const onEdit = vi.fn()
    expect(messageMenuItems({ onEdit })).toEqual([])
    expect(hasMessageMenu({ onEdit })).toBe(false)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it("gives only the high-frequency actions (Reply, Share) an icon; the rest text-only", () => {
    // Locked spec (uiux #14): single list; icons only on Reply + Share as
    // navigation anchors; low-freq actions are text (icon slot → placeholder).
    const items = messageMenuItems({
      onReply: () => {}, onShare: () => {}, onAddReaction: () => {},
      onCreateThread: () => {}, onPin: () => {}, onCopy: () => {}, onEdit: () => {},
    })
    const iconLabels = items.filter((it) => it.icon).map((it) => it.label)
    expect(iconLabels).toEqual(["Reply", "Share as Image"])
    for (const label of ["Add Reaction", "Create Thread", "Pin Message", "Copy Text"]) {
      expect(items.find((it) => it.label === label)?.icon).toBeUndefined()
    }
    expect(items.some((it) => it.label === "Edit Message")).toBe(false)
  })

  it("keeps the original row order — icons don't reorder the list (uiux #19)", () => {
    const labels = messageMenuItems({
      onReply: () => {}, onShare: () => {}, onAddReaction: () => {},
      onCreateThread: () => {}, onPin: () => {}, onCopy: () => {}, onEdit: () => {},
    }).map((it) => it.label)
    expect(labels).toEqual(["Add Reaction", "Reply", "Create Thread", "Pin Message", "Copy Text", "Share as Image"])
    expect(labels).not.toContain("sep")
  })

  it("includes Mark only when onMark is provided, and toggles label on `marked`", () => {
    expect(messageMenuItems({}).some((it) => it.label === "Mark")).toBe(false)
    // Unmarked (or state not yet resolved) → "Mark"; text-only like Pin.
    const mark = messageMenuItems({ onMark: () => {} })
    expect(mark.some((it) => it.label === "Mark")).toBe(true)
    expect(mark.find((it) => it.label === "Mark")?.icon).toBeUndefined()
    // Already marked → "Unmark".
    const unmark = messageMenuItems({ onMark: () => {}, marked: true })
    expect(unmark.some((it) => it.label === "Unmark")).toBe(true)
    expect(unmark.some((it) => it.label === "Mark")).toBe(false)
  })

  it("wires the Mark/Unmark onClick to the same onMark handler", () => {
    const onMark = vi.fn()
    messageMenuItems({ onMark }).find((it) => it.label === "Mark")?.onClick?.()
    messageMenuItems({ onMark, marked: true }).find((it) => it.label === "Unmark")?.onClick?.()
    expect(onMark).toHaveBeenCalledTimes(2)
  })

  it("orders Mark right after Pin (both text-only, before Copy)", () => {
    const labels = messageMenuItems({
      onReply: () => {}, onPin: () => {}, onMark: () => {}, onCopy: () => {},
    }).map((it) => it.label)
    expect(labels).toEqual(["Reply", "Pin Message", "Mark", "Copy Text"])
  })
})

describe("messageLinkMenuItems", () => {
  const linkTarget = { href: "https://example.com/second?mode=full#details" }

  it("stays absent unless one exact target and both actions are available", () => {
    expect(messageLinkMenuItems({})).toEqual([])
    expect(messageLinkMenuItems({ linkTarget })).toEqual([])
    expect(messageLinkMenuItems({ linkTarget, onCopyLink: () => {} })).toEqual([])
  })

  it("appends Copy Link then Open Link and passes the same structured target", () => {
    const onCopyLink = vi.fn()
    const onOpenLink = vi.fn()
    const items = messageLinkMenuItems({ linkTarget, onCopyLink, onOpenLink })

    expect(items.map((item) => item.label)).toEqual(["Copy Link", "Open Link"])
    expect(items[0]?.icon).toBeUndefined()
    expect(items[1]?.icon).toBeDefined()
    items[0]?.onClick?.()
    items[1]?.onClick?.()
    expect(onCopyLink).toHaveBeenCalledWith(linkTarget)
    expect(onOpenLink).toHaveBeenCalledWith(linkTarget)
  })
})
