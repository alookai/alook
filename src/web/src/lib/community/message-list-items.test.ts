import { describe, it, expect } from "vitest"
import { flattenMessageItems, estimateRowHeight, computeBelowCount } from "./message-list-items"
import type { Msg } from "./models/message"

function msg(overrides: Partial<Msg> & { id: string }): Msg {
  return {
    type: "chat",
    authorId: "alice",
    authorName: "Alice",
    content: "hello",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  }
}

describe("flattenMessageItems", () => {
  it("splits8px internal and16px external gaps across the adjacent canonical author rows", () => {
    const rows = flattenMessageItems([
      msg({ id: "m1" }), msg({ id: "m2", authorName: "Renamed Alice" }), msg({ id: "m3" }),
      msg({ id: "m4", authorId: "another-alice" }),
    ], undefined).filter(item => item.kind === "message")
    expect(rows.map(item => item.m.grouped)).toEqual([false, true, true, false])
    expect(rows).toMatchObject([
      { paddingTop: 8, paddingBottom: 4 }, { paddingTop: 4, paddingBottom: 4 },
      { paddingTop: 4, paddingBottom: 8 }, { paddingTop: 8, paddingBottom: 8 },
    ])
  })

  it.each([
    { type: "system" as const },
    { replyTo: { id: "prior", authorName: "Alice", text: "reply" } },
    { authorId: undefined },
  ])("does not group either side of a system/reply/unknown-identity row: %j", (boundary) => {
    const rows = flattenMessageItems([msg({ id: "m1" }), msg({ id: "m2", ...boundary }), msg({ id: "m3" })], undefined)
      .filter(item => item.kind === "message")
    expect(rows.map(item => item.m.grouped)).toEqual([false, false, false])
    expect(rows).toMatchObject(Array.from({ length: 3 }, () => ({ paddingTop: 8, paddingBottom: 8 })))
  })

  it("breaks grouping at New while preserving the pending-window avatar rule without an unknown spacing link", () => {
    const rows = flattenMessageItems([msg({ id: "m1" }), msg({ id: "m2" })], "m2", true)
      .filter(item => item.kind === "message")
    expect(rows.map(item => item.m.grouped)).toEqual([true, false])
    expect(rows).toMatchObject([{ paddingTop: 8, paddingBottom: 8 }, { paddingTop: 8, paddingBottom: 8 }])
  })
  it.each(["2026-01-01T10:07:00.000Z", "2026-01-01T09:59:00.000Z"])("does not join an exact7-minute or reverse-time boundary: %s", (createdAt) => {
    const rows = flattenMessageItems([msg({ id: "m1" }), msg({ id: "m2", createdAt })], undefined)
      .filter(item => item.kind === "message")
    expect(rows.map(item => item.m.grouped)).toEqual([false, false])
    expect(rows).toMatchObject([{ paddingTop: 8, paddingBottom: 8 }, { paddingTop: 8, paddingBottom: 8 }])
  })
  it("gives the leading content, date and message independent stable rows", () => {
    const items = flattenMessageItems([msg({ id: "m1" })], undefined)
    expect(items.map(item => item.kind)).toEqual(["leading", "divider", "message"])
    expect(items[1]).toMatchObject({ messageId: "m1", dateLabel: expect.any(String) })
    expect(items[2]).toMatchObject({ kind: "message", key: "msg:id:m1" })
    expect(items[2]).not.toHaveProperty("dateLabel")
  })

  it("adds a date row only at the first message of each day", () => {
    const items = flattenMessageItems([
      msg({ id: "m1" }),
      msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      msg({ id: "m3", createdAt: "2026-01-02T12:00:00.000Z" }),
    ], undefined)
    expect(items.filter(item => item.kind === "divider").map(item => item.messageId)).toEqual(["m1", "m3"])
    expect(items.filter(item => item.kind === "message").map(item => item.m.id)).toEqual(["m1", "m2", "m3"])
  })

  it("gives same-day New its own key while preserving the message keys", () => {
    const messages = [msg({ id: "m1" }), msg({ id: "m2" })]
    const items = flattenMessageItems(messages, "m2")
    expect(items).toHaveLength(5)
    expect(items[3]).toMatchObject({ kind: "divider", newDivider: true, messageId: "m2" })
    expect(items[3]).not.toHaveProperty("dateLabel")
    expect(items.filter(item => item.kind === "message").map(item => item.key))
      .toEqual(flattenMessageItems(messages, undefined).filter(item => item.kind === "message").map(item => item.key))
  })

  it("merges date and New in one divider before the actual message", () => {
    const items = flattenMessageItems([
      msg({ id: "m1", createdAt: "2026-01-01T12:00:00.000Z" }),
      msg({ id: "m2", createdAt: "2026-01-02T12:00:00.000Z" }),
    ], "m2")
    expect(items).toHaveLength(5)
    expect(items[3]).toMatchObject({ kind: "divider", messageId: "m2", newDivider: true, dateLabel: expect.any(String) })
    expect(items.filter(item => item.kind === "divider")).toHaveLength(2)
  })

  it("does not invent a New row for an absent anchor", () => {
    expect(flattenMessageItems([msg({ id: "m1" })], "absent").some(item => item.kind === "divider" && item.newDivider)).toBe(false)
  })

  it("keeps the old first message key when a same-day prepend removes its date prefix", () => {
    const anchor = msg({ id: "anchor", createdAt: "2026-01-01T12:01:00.000Z" })
    const original = flattenMessageItems([anchor], "anchor").find(item => item.kind === "message")!
    const next = flattenMessageItems([msg({ id: "older", createdAt: "2026-01-01T12:00:00.000Z" }), anchor], undefined)
      .find(item => item.kind === "message" && item.m.id === "anchor")!
    expect(next.key).toBe(original.key)
    expect(next).not.toHaveProperty("dateLabel")
    expect(next).not.toHaveProperty("newDivider")
    expect(next.m.grouped).toBe(true)
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
        msg({ id: "m2", authorId: "bob", authorName: "Bob", createdAt: "2026-01-01T10:01:00.000Z" }),
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

  it("forces the window-first chat message to grouped when an older page is still pending (hasMoreOlder) — avoids the reload avatar-flash", () => {
    // Reverse-infinite window with older content beyond the top: the first
    // message's true predecessor isn't loaded yet, so default it to grouped
    // (no avatar) rather than guess ungrouped and pop-out on prepend.
    const items = flattenMessageItems(
      [
        msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", authorId: "bob", authorName: "Bob", createdAt: "2026-01-01T10:01:00.000Z" }),
      ],
      undefined,
      true,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    // First message forced grouped despite having no prev (older page pending).
    expect(messageItems[0].m.grouped).toBe(true)
    // A genuinely different author below still groups by the real rule.
    expect(messageItems[1].m.grouped).toBe(false)
  })

  it("keeps the window-first message ungrouped when the top is truly reached (hasMoreOlder false) — its avatar shows correctly", () => {
    const items = flattenMessageItems(
      [msg({ id: "m1", authorName: "Alice", createdAt: "2026-01-01T10:00:00.000Z" })],
      undefined,
      false,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[0].m.grouped).toBe(false)
  })

  it("does not force-group a window-first SYSTEM message even with an older page pending", () => {
    const items = flattenMessageItems(
      [msg({ id: "m1", type: "system", systemKind: "thread" })],
      undefined,
      true,
    )
    const messageItems = items.filter((i) => i.kind === "message")
    expect(messageItems[0].m.grouped).toBe(false)
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

  it("keeps repeated calendar-day boundaries distinct and excludes both loading edges from message counts", () => {
    const items = flattenMessageItems([
      msg({ id: "m1", createdAt: "2026-01-01T12:00:00.000Z" }),
      msg({ id: "m2", createdAt: "2026-01-02T12:00:00.000Z" }),
      msg({ id: "m3", createdAt: "2026-01-01T12:01:00.000Z" }),
    ], "m2", true, true)
    expect(new Set(items.map(item => item.key)).size).toBe(items.length)
    expect(items.at(-1)?.kind).toBe("trailing")
    expect(computeBelowCount(items, 0)).toBe(3)
    expect(computeBelowCount(items, items.length - 2)).toBe(0)
  })

  it("keeps the FlatItem key stable across temp id, server id, and GET refetch", () => {
    const keyFor = (message: Msg) =>
      flattenMessageItems([message], undefined).find((item) => item.kind === "message")!.key
    const optimistic = msg({ id: "temp_1", authorId: "u_me", clientNonce: "nonce-1" })
    const reconciled = { ...optimistic, id: "message_1", seq: 8 }
    const refetched = { ...reconciled, content: "canonical", createdAt: "2026-01-01T10:00:01.000Z" }
    expect(keyFor(optimistic)).toBe(keyFor(reconciled))
    expect(keyFor(reconciled)).toBe(keyFor(refetched))
  })

  it("pairs nonce identity with author and rejects server fallback nonces", () => {
    const keys = flattenMessageItems(
      [
        msg({ id: "m1", authorId: "u1", clientNonce: "same" }),
        msg({ id: "m2", authorId: "u2", clientNonce: "same" }),
        msg({ id: "m3", authorId: "u3", clientNonce: "srv:fallback" }),
        msg({ id: "m4", authorId: "u4" }),
      ],
      undefined,
    ).filter((item) => item.kind === "message").map((item) => item.key)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[2]).toBe("msg:id:m3")
    expect(keys[3]).toBe("msg:id:m4")
  })
})

describe("estimateRowHeight", () => {
  it("estimates independent decorations without changing the message estimate", () => {
    expect(estimateRowHeight({ kind: "divider", key: "date", messageId: "m1", dateLabel: "Today" })).toBe(32)
    expect(estimateRowHeight({ kind: "divider", key: "new", messageId: "m1", newDivider: true })).toBe(24)
    expect(estimateRowHeight({ kind: "divider", key: "both", messageId: "m1", dateLabel: "Today", newDivider: true })).toBe(32)
    expect(estimateRowHeight({ kind: "leading", key: "leading" }, true)).toBe(88)
    expect(estimateRowHeight({ kind: "trailing", key: "trailing" })).toBe(56)
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

  it("reserves reply-header height before measurement", () => {
    const withoutReply = flattenMessageItems([msg({ id: "m1" })], undefined)
      .find((item) => item.kind === "message")!
    const withReply = flattenMessageItems([
      msg({
        id: "m1",
        replyTo: { id: "reply_1", authorName: "Bob", text: "preview" },
      }),
    ], undefined).find((item) => item.kind === "message")!
    expect(estimateRowHeight(withReply) - estimateRowHeight(withoutReply)).toBe(28)
  })
})

describe("computeBelowCount", () => {
  // Three messages on the same day → [date-divider, message, message, message]
  const items = flattenMessageItems(
    [
      msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
      msg({ id: "m2", createdAt: "2026-01-01T10:01:00.000Z" }),
      msg({ id: "m3", createdAt: "2026-01-01T10:02:00.000Z" }),
    ],
    undefined,
  )

  it("returns 0 when the last visible index is the last item", () => {
    expect(computeBelowCount(items, items.length - 1)).toBe(0)
  })

  it("counts only message rows strictly after the last visible index", () => {
    // lastVisibleIndex 1 (first message) → m2, m3 remain below = 2
    expect(computeBelowCount(items, items.findIndex(item => item.kind === "message" && item.m.id === "m1"))).toBe(2)
  })

  it("excludes divider rows below the fold from the count", () => {
    // Two days → [date-divider, m1, date-divider, m2]. With only the first
    // message visible (index 1), a naive itemCount-based count would report 2
    // (the trailing divider + m2); the message-only count is 1.
    const twoDay = flattenMessageItems(
      [
        msg({ id: "m1", createdAt: "2026-01-01T10:00:00.000Z" }),
        msg({ id: "m2", createdAt: "2026-01-02T10:00:00.000Z" }),
      ],
      undefined,
    )
    expect(twoDay.map((i) => i.kind)).toEqual(["leading", "divider", "message", "divider", "message"])
    expect(computeBelowCount(twoDay, 2)).toBe(1)
  })

  it("returns 0 for an empty list", () => {
    expect(computeBelowCount([], -1)).toBe(0)
  })

  it("returns 0 when lastVisibleIndex is at or beyond the last index", () => {
    expect(computeBelowCount(items, 99)).toBe(0)
  })
})
