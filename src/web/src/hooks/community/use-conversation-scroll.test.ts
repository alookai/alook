import { describe, expect, it } from "vitest"
import {
  findMessageIndex,
  findMountScrollTargetIndex,
  measureMessageRow,
  resolveViewportResizeAnchor,
} from "./use-conversation-scroll"
import type { FlatItem } from "@/lib/community/message-list-items"

function message(id: string): FlatItem {
  return {
    kind: "message",
    key: `msg:${id}`,
    m: {
      id,
      type: "chat",
      authorName: "Alice",
      content: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      grouped: false,
    },
  }
}

describe("resolveViewportResizeAnchor", () => {
  it("preserves exact distance from the bottom when anchored at tail", () => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 500,
      nextClientHeight: 340,
      previousScrollHeight: 2000,
      nextScrollHeight: 2000,
      previousScrollTop: 1490,
      atBottom: true,
    })).toEqual({
      anchor: "tail",
      scrollTop: 1650,
      distanceToEnd: 10,
    })
  })

  it("preserves scrollTop when reading history away from tail", () => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 500,
      nextClientHeight: 340,
      previousScrollHeight: 2000,
      nextScrollHeight: 2000,
      previousScrollTop: 600,
      atBottom: false,
    })).toEqual({
      anchor: "start",
      scrollTop: 600,
      distanceToEnd: 900,
    })
  })

  it("clamps requested scrollTop within the new max scroll range", () => {
    expect(resolveViewportResizeAnchor({
      previousClientHeight: 500,
      nextClientHeight: 900,
      previousScrollHeight: 1200,
      nextScrollHeight: 1200,
      previousScrollTop: 680,
      atBottom: true,
    })).toEqual({
      anchor: "tail",
      scrollTop: 280,
      distanceToEnd: 20,
    })
  })
})

describe("measureMessageRow", () => {
  it("takes the ceiling of the larger of bounding rect height and scrollHeight", () => {
    const element = {
      getBoundingClientRect: () => ({ height: 379.4 }),
      scrollHeight: 379,
    } as unknown as Element
    expect(measureMessageRow(element)).toBe(380)

    const overflowing = {
      getBoundingClientRect: () => ({ height: 400 }),
      scrollHeight: 813,
    } as unknown as Element
    expect(measureMessageRow(overflowing)).toBe(813)
  })
})

describe("findMountScrollTargetIndex and findMessageIndex", () => {
  it("prefers the new divider above the target message and falls back to the message row", () => {
    const items: FlatItem[] = [
      { kind: "leading", key: "rail:leading" },
      message("m1"),
      { kind: "divider", key: "new:m2", messageId: "m2", newDivider: true },
      message("m2"),
    ]
    expect(findMountScrollTargetIndex(items, "m2")).toBe(2)
    expect(findMessageIndex(items, "m2")).toBe(3)
    expect(findMountScrollTargetIndex(items, "m1")).toBe(1)
    expect(findMountScrollTargetIndex(items, "missing")).toBeNull()
    expect(findMessageIndex(items, "missing")).toBeNull()
  })
})
