import { describe, it, expect } from "vitest"
import { decideScrollAction, createScrollAnchorState, NEAR_BOTTOM_PX, type ScrollAnchorState, type ScrollAnchorMessage } from "./use-scroll-anchor"

const msgs = (...ids: string[]): ScrollAnchorMessage[] => ids.map((id) => ({ id }))

function baseInput(overrides: Partial<Parameters<typeof decideScrollAction>[0]> = {}) {
  return {
    state: createScrollAnchorState(),
    messages: msgs("m1", "m2", "m3"),
    initialScrollReady: true,
    scrollHeight: 1000,
    scrollTop: 0,
    clientHeight: 500,
    ...overrides,
  }
}

describe("decideScrollAction — mount", () => {
  it("centers on the NEW divider when present", () => {
    const { action, nextState } = decideScrollAction(baseInput({ newDividerBefore: "m2" }))
    expect(action).toEqual({ type: "mount", newDividerBefore: "m2" })
    expect(nextState.didInitialScroll).toBe(true)
  })

  it("scrolls to bottom when no NEW divider is present", () => {
    const { action } = decideScrollAction(baseInput())
    expect(action).toEqual({ type: "mount", newDividerBefore: undefined })
  })

  it("does not fire (and does not consume the one-shot gate) until initialScrollReady", () => {
    const { action, nextState } = decideScrollAction(baseInput({ initialScrollReady: false }))
    expect(action).toEqual({ type: "none" })
    expect(nextState.didInitialScroll).toBe(false)
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
})

// Helper: state as-if mount already happened, tail = "m3".
function mountedState(overrides: Partial<ScrollAnchorState> = {}): ScrollAnchorState {
  return {
    didInitialScroll: true,
    lastHeadId: "m1",
    lastTailId: "m3",
    lastScrollHeight: 1000,
    lastMessagesLen: 3,
    lastHasMore: undefined,
    ...overrides,
  }
}

describe("decideScrollAction — self-send / peer-follow", () => {
  it("self-send (tail author === viewer) snaps to bottom regardless of distance from bottom", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "viewer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer", scrollTop: 0 }))
    expect(action).toEqual({ type: "scrollToBottom" })
  })

  it("peer send within NEAR_BOTTOM_PX of bottom snaps to bottom", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    // scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX
    const { action } = decideScrollAction(
      baseInput({ state, messages, viewerUserId: "viewer", scrollHeight: 1000, scrollTop: 950, clientHeight: 500 }),
    )
    expect(action).toEqual({ type: "scrollToBottom" })
  })

  it("peer send beyond NEAR_BOTTOM_PX does not scroll — leaves the pill to prompt the user back down", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(
      baseInput({ state, messages, viewerUserId: "viewer", scrollHeight: 2000, scrollTop: 0, clientHeight: 500 }),
    )
    expect(action).toEqual({ type: "none" })
  })

  it("peer send is ignored (no auto-follow) when hasMoreNewer is true — loaded window isn't tail-attached", () => {
    const state = mountedState()
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(
      baseInput({ state, messages, viewerUserId: "viewer", hasMoreNewer: true, scrollHeight: 1000, scrollTop: 950, clientHeight: 500 }),
    )
    expect(action).toEqual({ type: "none" })
  })

  it("no action when the tail id is unchanged", () => {
    const state = mountedState()
    const { action } = decideScrollAction(baseInput({ state, viewerUserId: "viewer" }))
    expect(action).toEqual({ type: "none" })
  })

  it("temp-id → server-id reconcile: tail id changes via reconcileServerId but author/content/position are otherwise unchanged — resolves as an idempotent self-send, not a misclassified prepend/hero-swap", () => {
    // Simulates: viewer sent a message (tempId "temp_123"), it's already the
    // tail, then the server responds and `reconcileServerId` swaps the id to
    // the real server id ("srv_abc") — same author, same position, nothing
    // about scroll position should change, but the tail id STRING changed.
    const state = mountedState({ lastTailId: "temp_123" })
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "srv_abc", authorId: "viewer" }]
    const { action } = decideScrollAction(baseInput({ state, messages, viewerUserId: "viewer" }))
    // Must resolve to the self-send branch (idempotent snap-to-bottom), not
    // "none" misclassified as no-op-but-actually-a-prepend, and not a
    // compensateDelta (which would require scrollHeight to have changed).
    expect(action).toEqual({ type: "scrollToBottom" })
  })
})

describe("decideScrollAction — prepend / hero-swap compensation", () => {
  it("compensates scrollTop delta when older messages prepend (head id changed, length grew)", () => {
    const state = mountedState({ lastHeadId: "m1", lastMessagesLen: 3, lastScrollHeight: 1000 })
    const messages = [{ id: "m0" }, { id: "m1" }, { id: "m2" }, { id: "m3" }]
    const { action } = decideScrollAction(baseInput({ state, messages, scrollHeight: 1200 }))
    expect(action).toEqual({ type: "compensateDelta", delta: 200 })
  })

  it("compensates scrollTop delta on a hero-swap (hasMore true → false, tail unchanged, top block grew)", () => {
    const state = mountedState({ lastHasMore: true, lastScrollHeight: 1000 })
    const { action } = decideScrollAction(baseInput({ state, hasMore: false, scrollHeight: 1090 }))
    expect(action).toEqual({ type: "compensateDelta", delta: 90 })
  })

  it("does not compensate when neither prepend nor hero-swap conditions hold", () => {
    const state = mountedState({ lastScrollHeight: 1000 })
    const { action } = decideScrollAction(baseInput({ state, scrollHeight: 1200 }))
    expect(action).toEqual({ type: "none" })
  })

  it("does not compensate a negative or zero delta", () => {
    const state = mountedState({ lastHeadId: "m1", lastMessagesLen: 3, lastScrollHeight: 1000 })
    const messages = [{ id: "m0" }, { id: "m1" }, { id: "m2" }, { id: "m3" }]
    const { action } = decideScrollAction(baseInput({ state, messages, scrollHeight: 1000 }))
    expect(action).toEqual({ type: "none" })
  })

  it("the compound case: a 0-row fetchOlder at start-of-history (hero-swap) coincides with a peer tail-send in the same update — exactly one action is chosen, no double-write", () => {
    // Before the fix, `heroSwap` was gated on `prevTail === nextTail`, which
    // silently swallowed this exact case: the tail DID change (peer send),
    // so the old check never fired even though the top block visibly
    // shifted the viewer's row down when hero swapped in. The new
    // `heroSwap` check has no such gate — it fires on the hasMore
    // transition alone, independent of what else changed this commit.
    // Priority order matters here: peer-follow is checked first (item #2),
    // but a peer message that's beyond NEAR_BOTTOM_PX doesn't scroll, so
    // hero-swap compensation (item #3) is free to fire in this commit.
    const state = mountedState({ lastHasMore: true, lastScrollHeight: 1000, lastTailId: "m3" })
    const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4", authorId: "peer" }]
    const { action } = decideScrollAction(
      baseInput({ state, messages, hasMore: false, viewerUserId: "viewer", scrollHeight: 1090, scrollTop: 0, clientHeight: 500 }),
    )
    // Exactly one action — the hero-swap compensation — not two competing
    // writes (no scrollToBottom AND compensateDelta both firing).
    expect(action).toEqual({ type: "compensateDelta", delta: 90 })
  })
})

describe("NEAR_BOTTOM_PX", () => {
  it("is the single shared threshold — was two disagreeing values (100px / 8px) before", () => {
    expect(NEAR_BOTTOM_PX).toBe(100)
  })
})
