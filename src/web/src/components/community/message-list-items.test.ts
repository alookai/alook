import { describe, it, expect } from "vitest"
import { flattenMessageItems, estimateRowHeight, computeBelowCount } from "./message-list-items"
import type { Msg } from "./_types"

function msg(overrides: Partial<Msg> & { id: string }): Msg {
  return {
    type: "chat",
    authorName: "Alice",
    content: "hello",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  }
}

describe("flattenMessageItems", () => {
  it("emits one 'message' item per message, plus a date-divider before the first message of a new day", () => {
    const items = flattenMessageItems([msg({ id: "m1" })], undefined)
    expect(items.map((i) => i.kind)).toEqual(["date-divider", "message"])
  })

  it("does not emit a date-divider between two messages on the same day", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      undefined,
    )
    expect(items.map((i) => i.kind)).toEqual(["date-divider", "message", "message"])
  })

  it("emits a second date-divider when the day changes", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-02T10:00:00.000Z" }),
      ],
      undefined,
    )
    expect(items.map((i) => i.kind)).toEqual(["date-divider", "message", "date-divider", "message"])
  })

  it("emits a new-divider item immediately before the message matching newDividerBefore", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      "m2",
    )
    expect(items.map((i) => i.kind)).toEqual(["date-divider", "message", "new-divider", "message"])
  })

  it("emits a same-day new-divider with no dateLabel (no merge)", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      "m2",
    )
    const newDivider = items.find((i) => i.kind === "new-divider")!
    expect(newDivider.dateLabel).toBeUndefined()
  })

  it("merges into ONE new-divider carrying a dateLabel when the unread anchor is the first message of a new day", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T12:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-02T12:00:00.000Z" }),
      ],
      "m2",
    )
    // No separate date-divider precedes the merged row — just message, then
    // the single new-divider carrying the day's label, then the message.
    expect(items.map((i) => i.kind)).toEqual(["date-divider", "message", "new-divider", "message"])
    const dividers = items.filter((i) => i.kind === "date-divider")
    expect(dividers).toHaveLength(1)
    const newDivider = items.find((i) => i.kind === "new-divider")!
    expect(typeof newDivider.dateLabel).toBe("string")
    expect(newDivider.dateLabel!.length).toBeGreaterThan(0)
  })

  it("emits a plain date-divider (no new-divider) when there is no unread anchor", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T12:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-02T12:00:00.000Z" }),
      ],
      undefined,
    )
    expect(items.some((i) => i.kind === "new-divider")).toBe(false)
    expect(items.filter((i) => i.kind === "date-divider")).toHaveLength(2)
  })

  it("marks a message 'grouped' when it's a same-author chat reply within the grouping window on the same day", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorName: "Alice", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[0].m.grouped).toBe(false)
    expect(messageItems[1].m.grouped).toBe(true)
  })

  it("does not group across a 7+ minute gap", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorName: "Alice", createdAt: "2026-01-01T10:08:00.000Z" }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("does not group across a different author", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorName: "Bob", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("does not group a reply message even from the same author within the window", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorName: "Alice", createdAt: "2026-01-01T10:01:00.000Z", replyTo: { id: "m1", authorName: "Alice", text: "hi" } }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("does not group a system message even from the same author within the window", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorName: "Alice", createdAt: "2026-01-01T10:01:00.000Z", type: "system" }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("does not group across a date-divider even if the author/window would otherwise match", () => {
    // Noon-to-noon (rather than a near-midnight boundary) so this holds
    // regardless of the test runner's local timezone offset — `dateKey`
    // compares LOCAL calendar days, and a near-midnight UTC pair can land
    // on the same local day in some timezones.
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T12:00:00.000Z" }),
        msg({ id: "m2", authorName: "Alice", createdAt: "2026-01-02T12:00:30.000Z" }),
      ],
      undefined,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("returns an empty array for no messages", () => {
    expect(flattenMessageItems([], undefined)).toEqual([])
  })

  it("gives every item a unique, stable key", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      "m2",
    )
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("estimateRowHeight", () => {
  it("returns a fixed constant for a date-divider row", () => {
    const items = flattenMessageItems([msg({ id: "m1" })], undefined)
    const divider = items.find((i) => i.kind === "date-divider")!
    expect(estimateRowHeight(divider)).toBeGreaterThan(0)
    expect(estimateRowHeight(divider)).toBe(estimateRowHeight(divider))
  })

  it("returns a fixed constant for a new-divider row, distinct in value from an empty message row (dividers are shorter)", () => {
    const items = flattenMessageItems(
      [msg({ id: "m1" }), msg({ id: "m2" })],
      "m2",
    )
    const newDivider = items.find((i) => i.kind === "new-divider")!
    const message = items.find((i) => i.kind === "message")!
    expect(estimateRowHeight(newDivider)).toBeLessThan(estimateRowHeight(message))
  })

  it("estimates a merged new-divider (with dateLabel) taller than a bare one, matching the date-divider height", () => {
    const merged = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T12:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-02T12:00:00.000Z" }),
      ],
      "m2",
    ).find((i) => i.kind === "new-divider")!
    const bare = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      "m2",
    ).find((i) => i.kind === "new-divider")!
    const dateDivider = flattenMessageItems([msg({ id: "m1" })], undefined).find((i) => i.kind === "date-divider")!
    expect(estimateRowHeight(merged)).toBeGreaterThan(estimateRowHeight(bare))
    expect(estimateRowHeight(merged)).toBe(estimateRowHeight(dateDivider))
  })

  it("scales up with longer text content", () => {
    const items = flattenMessageItems(
      [
        msg({ id: "m1", content: "short" }),
        msg({ id: "m2", content: "a".repeat(500) }),
      ],
      undefined,
    )
    const messages = items.filter((i) => i.kind === "message")
    expect(estimateRowHeight(messages[1])).toBeGreaterThan(estimateRowHeight(messages[0]))
  })

  it("adds height for an image attachment using its real aspect ratio when width/height are known", () => {
    const wide = flattenMessageItems(
      [msg({ id: "m1", content: "", attachments: [{ kind: "image", name: "a.png", url: "/a.png", width: 1600, height: 400 }] })],
      undefined,
    ).find((i) => i.kind === "message")!
    const tall = flattenMessageItems(
      [msg({ id: "m1", content: "", attachments: [{ kind: "image", name: "a.png", url: "/a.png", width: 400, height: 1600 }] })],
      undefined,
    ).find((i) => i.kind === "message")!
    // A tall (narrow, high) image renders taller within the same max-width
    // box than a wide (short) image — the estimate must reflect that, not
    // treat every image attachment as the same fixed addend.
    expect(estimateRowHeight(tall)).toBeGreaterThan(estimateRowHeight(wide))
  })

  it("adds a fallback addend for an image attachment with no known dimensions (pre-feature rows)", () => {
    const withImage = flattenMessageItems(
      [msg({ id: "m1", content: "", attachments: [{ kind: "image", name: "a.png", url: "/a.png" }] })],
      undefined,
    ).find((i) => i.kind === "message")!
    const withoutImage = flattenMessageItems(
      [msg({ id: "m1", content: "" })],
      undefined,
    ).find((i) => i.kind === "message")!
    expect(estimateRowHeight(withImage)).toBeGreaterThan(estimateRowHeight(withoutImage))
  })
})

describe("computeBelowCount", () => {
  it("returns 0 when the last visible index is the last item (itemCount - 1)", () => {
    expect(computeBelowCount(10, 9)).toBe(0)
  })

  it("returns the count of items strictly after the last visible index", () => {
    expect(computeBelowCount(10, 6)).toBe(3)
  })

  it("returns 0 for an empty list (itemCount 0, no items to be 'below')", () => {
    expect(computeBelowCount(0, -1)).toBe(0)
  })

  it("clamps to 0 rather than going negative if lastVisibleIndex somehow exceeds the last index", () => {
    expect(computeBelowCount(5, 10)).toBe(0)
  })
})
