import { describe, expect, it } from "vitest"
import { resolveMessageReadProjection, resolveUnreadMessageCount } from "./message-read-projection"

const messages = [
  { id: "self", authorId: "viewer" },
  { id: "anchor", authorId: "viewer" },
  { id: "peer", authorId: "peer" },
]

describe("resolveMessageReadProjection", () => {
  it("settles a warm canonical window without waiting for its query page marker", () => {
    expect(resolveMessageReadProjection({
      messages,
      lastReadMessageId: "anchor",
      viewerUserId: "viewer",
      anchorReconciled: false,
    })).toEqual({ newDividerBefore: "peer", anchorFound: true })
  })

  it("keeps an anchor-incomplete window unresolved until the anchor arrives", () => {
    expect(resolveMessageReadProjection({
      messages: [messages[2]],
      lastReadMessageId: "anchor",
      viewerUserId: "viewer",
      anchorReconciled: false,
    })).toEqual({ newDividerBefore: undefined, anchorFound: false })

    expect(resolveMessageReadProjection({
      messages: messages.slice(1),
      lastReadMessageId: "anchor",
      viewerUserId: "viewer",
      anchorReconciled: true,
    })).toEqual({ newDividerBefore: "peer", anchorFound: true })
  })

  it("distinguishes a pending first visit from a reconciled empty window", () => {
    expect(resolveMessageReadProjection({
      messages: [],
      lastReadMessageId: null,
      viewerUserId: "viewer",
      anchorReconciled: false,
    }).anchorFound).toBe(false)
    expect(resolveMessageReadProjection({
      messages: [],
      lastReadMessageId: null,
      viewerUserId: "viewer",
      anchorReconciled: true,
    }).anchorFound).toBe(true)
  })

  it("places a first-visit divider before the first peer row already in canonical data", () => {
    expect(resolveMessageReadProjection({
      messages,
      lastReadMessageId: null,
      viewerUserId: "viewer",
      anchorReconciled: false,
    })).toEqual({ newDividerBefore: "peer", anchorFound: true })
  })
})


describe("qualified unread message counts", () => {
  const count = (input: Partial<Parameters<typeof resolveUnreadMessageCount>[0]> = {}) => resolveUnreadMessageCount({ messages: [{ seq: 2 }, { seq: 5 }, { seq: 9 }], lastReadSeq: 2, latestSeq: 9, historyStartKnown: false, hasMoreNewer: false, ...input })
  it("counts actual messages across sequence gaps", () => { expect(count()).toBe(2); expect(count({ lastReadSeq: 5 })).toBe(1) })
  it("uses the proven history start when the old cursor was deleted", () => { expect(count({ lastReadSeq: 1, historyStartKnown: true })).toBe(3) })
  it("does not invent a count beyond an unloaded read boundary or tail", () => { expect(count({ lastReadSeq: 1 })).toBeUndefined(); expect(count({ hasMoreNewer: true })).toBeUndefined(); expect(count({ latestSeq: 10 })).toBeUndefined() })
  it("requires hydrated message sequences and deduplicates exact rows", () => { expect(count({ messages: [{ seq: 2 }, {}, { seq: 9 }] })).toBeUndefined(); expect(count({ messages: [{ seq: 2 }, { seq: 9 }, { seq: 9 }] })).toBe(1) })
  it("does not report messages past a fully covered cursor", () => { expect(count({ lastReadSeq: 9, hasMoreNewer: true })).toBe(0) })
})
