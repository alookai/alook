import { describe, it, expect } from "vitest"
import {
  decideScrollAction,
  createScrollAnchorState,
  computeHeroScrollCompensation,
  findMessageIndex,
  findMountScrollTargetIndex,
  extractScrollAnchorMessages,
  NEAR_BOTTOM_PX,
  type ScrollAnchorState,
  type ScrollAnchorMessage,
} from "./use-scroll-anchor"
import type { FlatItem } from "@/components/community/message-list-items"

const msgs = (...ids: string[]): ScrollAnchorMessage[] => ids.map((id) => ({ id }))

function baseInput(overrides: Partial<Parameters<typeof decideScrollAction>[0]> = {}) {
  return {
    state: createScrollAnchorState(),
    messages: msgs("m1", "m2", "m3"),
    initialScrollReady: true,
    heroMeasured: true,
    isAtEnd: true,
    ...overrides,
  }
}

describe("decideScrollAction — mount (rewritten — neither case is free with the virtualizer, both must be explicit)", () => {
  it("centers on the NEW divider when present", () => {
    const { action, nextState } = decideScrollAction(baseInput({ newDividerBefore: "m2" }))
    expect(action).toEqual({ type: "mount", newDividerBefore: "m2" })
    expect(nextState.didInitialScroll).toBe(true)
  })

  it("scrolls to end when no NEW divider is present — NOT free, must be an explicit action", () => {
    const { action } = decideScrollAction(baseInput())
    expect(action).toEqual({ type: "mount", newDividerBefore: undefined })
  })

  it("does not fire (and does not consume the one-shot gate) until initialScrollReady", () => {
    const { action, nextState } = decideScrollAction(baseInput({ initialScrollReady: false }))
    expect(action).toEqual({ type: "none" })
    expect(nextState.didInitialScroll).toBe(false)
  })

  it("does not fire (and does not consume the one-shot gate) until the hero has been measured at least once", () => {
    // Regression: the hero's real height is only known after its own
    // ResizeObserver effect runs (a later commit than the one that first
    // renders real messages). scrollMargin defaults to 0 until then — if
    // mount fired on that stale scrollMargin, scrollToIndex's offset math
    // (align: "center") would target the wrong scrollTop, and the
    // virtualizer's own reconcile loop stabilizes on that wrong value
    // within a frame, well before heroHeight's real value lands. Observed
    // as: page loads, view flashes at the tail then snaps to the top hero,
    // and unread messages near the true tail never enter the viewport so
    // useChannelWatermark never advances the read pointer.
    const { action, nextState } = decideScrollAction(baseInput({ heroMeasured: false }))
    expect(action).toEqual({ type: "none" })
    expect(nextState.didInitialScroll).toBe(false)
  })

  it("fires once both initialScrollReady and heroMeasured become true, even if one lagged behind the other", () => {
    const notReady = decideScrollAction(baseInput({ initialScrollReady: false, heroMeasured: false }))
    expect(notReady.action).toEqual({ type: "none" })
    const heroOnly = decideScrollAction(baseInput({ state: notReady.nextState, initialScrollReady: false, heroMeasured: true }))
    expect(heroOnly.action).toEqual({ type: "none" })
    const bothReady = decideScrollAction(baseInput({ state: heroOnly.nextState, initialScrollReady: true, heroMeasured: true }))
    expect(bothReady.action.type).toBe("mount")
  })

  it("fires exactly once — a second commit with didInitialScroll already true does not re-mount-scroll", () => {
    const first = decideScrollAction(baseInput())
    expect(first.action.type).toBe("mount")
    const second = decideScrollAction(baseInput({ state: first.nextState }))
    expect(second.action.type).not.toBe("mount")
  })

  it("does not fire on an empty message list, and does not consume the gate", () => {
    const { action, nextState } = decideScrollAction(baseInput({ messages: [] }))
    expect(action).toEqual({ type: "none" })
    expect(nextState.didInitialScroll).toBe(false)
  })

  it("re-arms and re-fires the mount scroll after a transient empty following the initial scroll", () => {
    // Regression (live-Playwright-verified): the message list can round-trip
    // through `[]` AFTER the initial scroll already fired, when a live path
    // invalidates the message query mid-mount — the observed trigger is
    // `useCommunityWs`'s `handleReconnect` firing ~1.5s into a fresh load and
    // invalidating both `channelMessages` and the `gcTime: 0` read-state
    // snapshot. Before the fix, the consumed one-shot gate stayed consumed,
    // so when rows returned the view was stuck at the top hero with the NEW
    // divider off-screen. The empty commit must RE-ARM the gate.
    const first = decideScrollAction(baseInput({ newDividerBefore: "m2" }))
    expect(first.action.type).toBe("mount")
    expect(first.nextState.didInitialScroll).toBe(true)

    // Mid-mount invalidation empties the list — gate must re-arm to false.
    const emptied = decideScrollAction(baseInput({ state: first.nextState, messages: [] }))
    expect(emptied.action).toEqual({ type: "none" })
    expect(emptied.nextState.didInitialScroll).toBe(false)

    // Rows return — mount must fire again to re-anchor on the NEW divider.
    const returned = decideScrollAction(baseInput({ state: emptied.nextState, newDividerBefore: "m2" }))
    expect(returned.action).toEqual({ type: "mount", newDividerBefore: "m2" })
    expect(returned.nextState.didInitialScroll).toBe(true)
  })
})

// Helper: state as-if mount already happened, tail = "m3".
function mountedState(overrides: Partial<ScrollAnchorState> = {}): ScrollAnchorState {
  return {
    didInitialScroll: true,
    lastTailId: "m3",
    ...overrides,
  }
}

describe("decideScrollAction — self-send / peer-follow (both hand-rolled — followOnAppend is deliberately off)", () => {
  it("self-send (tail author === viewer) snaps to bottom regardless of isAtEnd", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "viewer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer", isAtEnd: false }))
    expect(action).toEqual({ type: "scrollToEnd" })
  })

  it("peer send while isAtEnd is true snaps to bottom", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer", isAtEnd: true }))
    expect(action).toEqual({ type: "scrollToEnd" })
  })

  it("peer send while isAtEnd is false does not scroll — leaves the pill to prompt the user back down", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer", isAtEnd: false }))
    expect(action).toEqual({ type: "none" })
  })

  it("peer send is ignored (no auto-follow) when hasMoreNewer is true — loaded window isn't tail-attached, even if isAtEnd is true", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(
      baseInput({ state, messages, viewerUserId: "viewer", hasMoreNewer: true, isAtEnd: true }),
    )
    expect(action).toEqual({ type: "none" })
  })

  it("no action when the tail id is unchanged", () => {
    const state = mountedState()
    const { action } = decideScrollAction(baseInput({ state, viewerUserId: "viewer" }))
    expect(action).toEqual({ type: "none" })
  })

  it("temp-id → server-id reconcile: tail id changes via reconcileServerId but author/content/position are otherwise unchanged — resolves as an idempotent self-send, not a misclassified no-op", () => {
    // Simulates: viewer sent a message (tempId "temp_123"), it's already the
    // tail, then the server responds and `reconcileServerId` swaps the id to
    // the real server id ("srv_abc") — same author, same position, nothing
    // about scroll position should change, but the tail id STRING changed.
    // With getItemKey keyed on message id, this is a bigger structural event
    // for the virtualizer than it was for raw DOM (the item's key changes) —
    // still must resolve as self-send, not fall through to "none".
    const state = mountedState({ lastTailId: "temp_123" })
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "srv_abc", authorId: "viewer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer" }))
    expect(action).toEqual({ type: "scrollToEnd" })
  })
})

describe("NEAR_BOTTOM_PX", () => {
  it("is the single shared threshold, reused for both isAtEnd checks and the virtualizer's own scrollEndThreshold config", () => {
    expect(NEAR_BOTTOM_PX).toBe(100)
  })
})

describe("computeHeroScrollCompensation", () => {
  it("returns 0 when the hero's height is unchanged", () => {
    expect(computeHeroScrollCompensation(80, 80)).toBe(0)
  })

  it("returns a positive delta when the hero grows (e.g. sentinel swaps for the full 'Beginning of channel' block)", () => {
    expect(computeHeroScrollCompensation(0, 96)).toBe(96)
  })

  it("returns a negative delta when the hero shrinks", () => {
    expect(computeHeroScrollCompensation(96, 40)).toBe(-56)
  })
})

describe("findMountScrollTargetIndex", () => {
  const items: FlatItem[] = [
    { kind: "date-divider", label: "Today", key: "d1" },
    { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
    { kind: "new-divider", key: "new-divider" },
    { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
  ]

  it("prefers the new-divider ROW itself over the message row it precedes — it's now its own flattened item, thin, not the whole message box", () => {
    expect(findMountScrollTargetIndex(items, "m2")).toBe(2)
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
    { kind: "date-divider", label: "Today", key: "d1" },
    { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
    { kind: "message", m: { id: "m2", type: "chat", grouped: true }, key: "msg:m2" },
  ]

  it("returns the item-array index of the message with the given id", () => {
    expect(findMessageIndex(items, "m2")).toBe(2)
  })

  it("returns null when the id isn't present (message not loaded)", () => {
    expect(findMessageIndex(items, "unloaded")).toBeNull()
  })

  it("never matches a divider row even if some future divider carried an overlapping id-like key", () => {
    expect(findMessageIndex(items, "d1")).toBeNull()
  })
})

describe("extractScrollAnchorMessages", () => {
  it("extracts only 'message' items' id/authorId, in order, skipping dividers", () => {
    const items: FlatItem[] = [
      { kind: "date-divider", label: "Today", key: "d1" },
      { kind: "message", m: { id: "m1", type: "chat", grouped: false, authorId: "u1" }, key: "msg:m1" },
      { kind: "new-divider", key: "new-divider" },
      { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
    ]
    expect(extractScrollAnchorMessages(items)).toEqual([
      { id: "m1", authorId: "u1" },
      { id: "m2", authorId: undefined },
    ])
  })

  it("returns an empty array when there are no message items", () => {
    const items: FlatItem[] = [{ kind: "date-divider", label: "Today", key: "d1" }]
    expect(extractScrollAnchorMessages(items)).toEqual([])
  })
})
