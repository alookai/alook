/**
 * Menu-parity regression guard (uiux #29 — Alli/Shelly, 2026-07-29).
 *
 * There is exactly ONE message-action menu in community: the `messageMenuItems`
 * factory, rendered by the `Message` component for both the right-click
 * ContextMenu and the ⋯ DropdownMenu. Every surface that shows a message — the
 * main list, the mobile long-press menu (same ContextMenu), and the #N-ref
 * context sheet (which renders rows through MessageRow → Message) — routes
 * through that one factory, so they are aligned by construction.
 *
 * "Share as Image" is the action most likely to silently diverge, because it is
 * NOT passed in as a handler — `Message` derives it from the message via
 * `messageCanShare`. This guard pins that derivation and the resulting menu
 * shape so a future edit can't strip Share from (or reorder) the menu on any
 * surface — including the context sheet, whose parity is entirely transitive.
 */
import { describe, it, expect } from "vitest"
import { messageCanShare } from "./message"
import { messageMenuItems } from "./message-menu"
import type { RenderMsg } from "./_types"

const msg = (over: Partial<RenderMsg> = {}): RenderMsg =>
  ({ id: "m1", content: "hello", grouped: false, ...over }) as RenderMsg

describe("messageCanShare — the derivation that gives every surface Share", () => {
  it("offers Share for a normal text message (the context-sheet case)", () => {
    // The context sheet renders non-compact rows, so this is exactly the
    // predicate result its long-press menu inherits.
    expect(messageCanShare(msg(), false)).toBe(true)
    expect(messageCanShare(msg(), undefined)).toBe(true)
  })

  it("withholds Share when there's nothing to put on the card", () => {
    expect(messageCanShare(msg({ content: "" }), false)).toBe(false)
    expect(messageCanShare(msg({ approval: {} as RenderMsg["approval"] }), false)).toBe(false)
    expect(messageCanShare(msg(), true)).toBe(false) // compact rows opt out
  })
})

describe("the menu a content message produces on any surface", () => {
  // The handler set `Message` builds for a full-featured content message: every
  // action wired, Share on because messageCanShare is true.
  const items = messageMenuItems({
    onAddReaction: () => {},
    onReply: () => {},
    onCreateThread: () => {},
    onPin: () => {},
    onCopy: () => {},
    onShare: messageCanShare(msg(), false) ? () => {} : undefined,
  })

  it("includes Share as Image in the locked order", () => {
    expect(items.map((it) => it.label)).toEqual([
      "Add Reaction",
      "Reply",
      "Create Thread",
      "Pin Message",
      "Copy Text",
      "Share as Image",
    ])
  })

  it("gives an icon only to the high-frequency actions (Reply, Share)", () => {
    expect(items.filter((it) => it.icon).map((it) => it.label)).toEqual([
      "Reply",
      "Share as Image",
    ])
  })
})
