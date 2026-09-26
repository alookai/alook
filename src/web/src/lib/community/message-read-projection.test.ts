import { describe, expect, it } from "vitest"
import { resolveMessageReadProjection } from "./message-read-projection"

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
