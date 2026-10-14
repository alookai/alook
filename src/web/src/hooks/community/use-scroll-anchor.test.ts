import { describe, it, expect } from "vitest"
import {
  findMessageIndex,
  findMountScrollTargetIndex,
  measureMessageRow,
  MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX,
  resolveViewportResizeAnchor,
} from "./use-scroll-anchor"
import { MESSAGE_ROW_VERTICAL_PADDING_PX, type FlatItem } from "@/lib/community/message-list-items"
import { COMPOSER_ACCESSORY_ROW_HEIGHT_PX, CONVERSATION_TAIL_SPACE_PX, MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"

describe("message rail tail geometry", () => {
  it("counts the final row's 8px once in the shared 40px clearance", () => {
    expect(MESSAGE_ROW_VERTICAL_PADDING_PX).toBe(8)
    expect(MESSAGE_RAIL_TAIL_PADDING_END_PX).toBe(32)
    expect(MESSAGE_RAIL_TAIL_PADDING_END_PX + MESSAGE_ROW_VERTICAL_PADDING_PX).toBe(CONVERSATION_TAIL_SPACE_PX)
    expect(CONVERSATION_TAIL_SPACE_PX).toBe(40)
    expect(COMPOSER_ACCESSORY_ROW_HEIGHT_PX).toBe(32)
  })
})

describe("resolveViewportResizeAnchor", () => {
  it.each([0, 2, 100])("preserves a %ipx tail distance across footer growth", (distance) => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 800,
      nextClientHeight: 608,
      previousScrollHeight: 1_600,
      nextScrollHeight: 1_600,
      previousScrollTop: 800 - distance,
    })).toEqual({
      anchor: "tail",
      scrollTop: 992 - distance,
      distanceToEnd: distance,
    })
  })

  it("preserves a 300px reading position across footer growth", () => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 800,
      nextClientHeight: 608,
      previousScrollHeight: 1_600,
      nextScrollHeight: 1_600,
      previousScrollTop: 500,
    })).toEqual({
      anchor: "start",
      scrollTop: 500,
      distanceToEnd: 300,
    })
  })

  it("uses tail distance when viewport expansion makes the old top impossible", () => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 608,
      nextClientHeight: 800,
      previousScrollHeight: 1_600,
      nextScrollHeight: 1_600,
      previousScrollTop: 842,
    })).toEqual({
      anchor: "tail",
      scrollTop: 650,
      distanceToEnd: 150,
    })
  })
})

describe("MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX", () => {
  it("keeps the 100px presentation and viewport policy separate from physical follow", () => {
    expect(MESSAGE_LIST_DISPLAY_END_THRESHOLD_PX).toBe(100)
  })
})

describe("measureMessageRow", () => {
  it("re-reads a mounted row after Markdown grows beyond the capped initial estimate", () => {
    let height = 380
    const element = {
      getBoundingClientRect: () => ({ height }),
      get scrollHeight() {
        return Math.ceil(height)
      },
    } as unknown as Element

    expect(measureMessageRow(element)).toBe(380)
    height = 812.4
    expect(measureMessageRow(element)).toBe(813)
  })

  it("uses overflowing content as the row footprint so the following row cannot intersect it", () => {
    const element = {
      getBoundingClientRect: () => ({ height: 400 }),
      scrollHeight: 967,
    } as unknown as Element

    expect(measureMessageRow(element)).toBe(967)
  })
})

describe("findMountScrollTargetIndex", () => {
  const items: FlatItem[] = [
    { kind: "leading", key: "leading" },
    { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
    { kind: "divider", messageId: "m2", newDivider: true, key: "new:m2" },
    { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
  ]

  it("selects the independent New index while a message target selects the actual body", () => {
    expect(findMountScrollTargetIndex(items, "m2")).toBe(2)
    expect(findMessageIndex(items, "m2")).toBe(3)
  })

  it("falls back to the message's own index when no new-divider item exists (e.g. first-visit anchoring on a non-self message with no divider rendered)", () => {
    const noDivider: FlatItem[] = [
      { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
      { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
    ]
    expect(findMountScrollTargetIndex(noDivider, "m2")).toBe(1)
  })

  it("returns null when the target message isn't loaded", () => {
    expect(findMountScrollTargetIndex(items, "unloaded")).toBeNull()
  })
})

describe("findMessageIndex", () => {
  const items: FlatItem[] = [
    { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
    { kind: "message", m: { id: "m2", type: "chat", grouped: true }, key: "msg:m2" },
  ]

  it("returns the item-array index of the message with the given id", () => {
    expect(findMessageIndex(items, "m2")).toBe(1)
  })

  it("returns null when the id isn't present (message not loaded)", () => {
    expect(findMessageIndex(items, "unloaded")).toBeNull()
  })

  it("never matches a divider row even if some future divider carried an overlapping id-like key", () => {
    expect(findMessageIndex(items, "d1")).toBeNull()
  })
})
