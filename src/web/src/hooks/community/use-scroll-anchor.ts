import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

// Consolidates message-list.tsx's scroll-anchoring logic (previously 3
// separate `useLayoutEffect`s with 5+ independent refs and 2 disagreeing
// "near bottom" thresholds — see `record-debt-community-messages.md`
// findings #2/#10) into one hook with a single internal state object and a
// pure decision function (`decideScrollAction`), so exactly one scroll
// action — if any — happens per commit, in priority order. This directly
// fixes the debt record's verified same-commit double-write race
// (self-send snap-to-bottom followed by a stale prepend-delta add-on in the
// same layout-effect pass) and the silently-unhandled compound case
// (0-row `fetchOlder` at start-of-history coinciding with a peer tail-send
// in the same state update — neither the old `olderPrepended` nor
// `heroSwap` check fired, because both were guarded on the tail id staying
// put, which isn't true when a peer message also arrives in that same
// update).

// Shared "near bottom" threshold — was two disagreeing values before
// (100px for peer-follow, 8px for the "↓ N" pill's visibility check),
// which meant a 92px band existed where the pill said "not at bottom" while
// a peer message would still auto-scroll the viewer to the bottom anyway.
export const NEAR_BOTTOM_PX = 100

export interface ScrollAnchorMessage {
  id: string
  authorId?: string
}

export interface ScrollAnchorState {
  didInitialScroll: boolean
  lastHeadId: string | null
  lastTailId: string | null
  lastScrollHeight: number
  lastMessagesLen: number
  lastHasMore: boolean | undefined
}

export function createScrollAnchorState(): ScrollAnchorState {
  return {
    didInitialScroll: false,
    lastHeadId: null,
    lastTailId: null,
    lastScrollHeight: 0,
    lastMessagesLen: 0,
    lastHasMore: undefined,
  }
}

export interface DecideScrollActionInput {
  state: ScrollAnchorState
  messages: ScrollAnchorMessage[]
  newDividerBefore?: string
  initialScrollReady: boolean
  hasMore?: boolean
  hasMoreNewer?: boolean
  viewerUserId?: string
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export type ScrollAction =
  | { type: "none" }
  | { type: "mount"; newDividerBefore: string | undefined }
  | { type: "scrollToBottom" }
  | { type: "compensateDelta"; delta: number }

export interface DecideScrollActionResult {
  action: ScrollAction
  nextState: ScrollAnchorState
}

/**
 * Pure decision function — given the previous anchor state and this
 * commit's inputs, decides AT MOST ONE scroll action, in priority order:
 *   1. Mount-time initial scroll (fires exactly once).
 *   2. Self-send / peer-follow snap to bottom.
 *   3. Prepend / hero-swap delta compensation.
 * No DOM access — the caller (the hook) executes the chosen action against
 * the real scroll container. Exported for unit testing without DOM/hooks.
 */
export function decideScrollAction(input: DecideScrollActionInput): DecideScrollActionResult {
  const { state, messages, newDividerBefore, initialScrollReady, hasMore, hasMoreNewer, viewerUserId, scrollHeight, scrollTop, clientHeight } = input

  const nextHead = messages[0]?.id ?? null
  const nextTail = messages[messages.length - 1]?.id ?? null
  const nextLen = messages.length

  const baseNextState: ScrollAnchorState = {
    didInitialScroll: state.didInitialScroll,
    lastHeadId: nextHead,
    lastTailId: nextTail,
    lastScrollHeight: scrollHeight,
    lastMessagesLen: nextLen,
    lastHasMore: hasMore,
  }

  // Channel/DM cleared (or genuinely empty) — nothing to anchor. Don't
  // consume the mount one-shot gate; a real channel switch gets a fresh
  // hook instance anyway (see `useScrollAnchor`'s doc comment).
  if (nextLen === 0) {
    return { action: { type: "none" }, nextState: { ...baseNextState, didInitialScroll: state.didInitialScroll } }
  }

  // 1. Mount-time initial scroll — fires exactly once. Bails (without
  // consuming the gate) until `initialScrollReady` — running before the
  // owner's async anchor (e.g. `useChannelReadStateSnapshot`) resolves
  // would silently snap to the bottom and burn the one-shot gate.
  if (!state.didInitialScroll) {
    if (!initialScrollReady) {
      return { action: { type: "none" }, nextState: { ...baseNextState, didInitialScroll: false } }
    }
    return { action: { type: "mount", newDividerBefore }, nextState: { ...baseNextState, didInitialScroll: true } }
  }

  // 2. Self-send / peer-follow — only relevant when the tail actually moved.
  const tailChanged = state.lastTailId !== null && state.lastTailId !== nextTail
  if (tailChanged) {
    const tail = messages[messages.length - 1]
    const isSelfSend = !!viewerUserId && tail?.authorId === viewerUserId
    if (isSelfSend) {
      // Always follow — handles the composer path and, incidentally, the
      // optimistic temp-id → server-id reconcile (the tail id string
      // changes via `reconcileServerId` on send success, but the author is
      // still the viewer, so this branch still catches it as an idempotent
      // self-send snap, not a misclassified prepend/hero-swap).
      return { action: { type: "scrollToBottom" }, nextState: baseNextState }
    }
    // Peer send: only follow if the loaded window is tail-attached to the
    // present (`hasMoreNewer` false) AND the viewer is already at/near the
    // bottom — otherwise leave the "↓ N" pill to prompt them back down.
    if (!hasMoreNewer) {
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      if (distanceFromBottom < NEAR_BOTTOM_PX) {
        return { action: { type: "scrollToBottom" }, nextState: baseNextState }
      }
    }
  }

  // 3. Prepend / hero-swap compensation. `heroSwap` is intentionally NOT
  // gated on the tail staying put (unlike the old `prevTail === nextTail`
  // check it replaces) — that gate is exactly what silently swallowed the
  // compound case: a peer message arriving in the same update as a 0-row
  // `fetchOlder` at start-of-history changes the tail, which used to mask
  // the hero-swap compensation entirely even though the top block visibly
  // shifted the viewer's row down.
  const olderPrepended =
    state.lastHeadId !== null && nextHead !== null && state.lastHeadId !== nextHead && nextLen > state.lastMessagesLen
  const heroSwap = state.lastHasMore === true && hasMore === false
  if (state.lastScrollHeight > 0 && (olderPrepended || heroSwap)) {
    const delta = scrollHeight - state.lastScrollHeight
    if (delta > 0) {
      return { action: { type: "compensateDelta", delta }, nextState: baseNextState }
    }
  }

  return { action: { type: "none" }, nextState: baseNextState }
}

// Escape a message id for safe use inside an attribute selector. Message ids
// are nanoids in production (URL-safe alphabet), but the temp-id path
// (`temp_<Date.now()>_<rand>`) contains underscores that CSS accepts unescaped
// too. This is defensive against a future format change — CSS.escape is native
// in every runtime we ship to, but SSR and older test envs may lack it, so we
// fall back to a conservative replacer for non-identifier characters. Moved
// here (from `message-list.tsx`) since the mount action's DOM lookup below
// needs it; `message-list.tsx`'s `jumpTo` imports it from here too.
export function cssEscape(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id)
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

// Re-invoke `action` whenever the scroll container's own size changes.
// Serves both initial scroll (images decoding on a cold browser cache
// arrive after the first scrollTo — target row was still short at that
// moment) and self-send (composer stays in view when an image the user
// just attached finishes decoding).
//
// Bails when:
// - the user scrolls (wheel / touchstart — the only reliable "user
//   intent" signal during async growth; programmatic scroll fires its
//   own `scroll` events, so scrollTop comparisons can't distinguish).
// - the watchdog window elapses (3s — long enough for large images and
//   mermaid renders, short enough that the effect doesn't linger).
//
// rAF coalescing: multiple ResizeObserver fires in the same frame
// dispatch one `action` call. Without this, several images finishing
// decode in one layout tick would each call `action` on an intermediate
// scrollHeight before the browser settles on the final value.
//
// Returns a cleanup that owners MUST return from their effect.
const ASYNC_GROWTH_WINDOW_MS = 3000
function watchAsyncGrowth(el: HTMLElement, action: () => void): () => void {
  // Observe the scroll container's FIRST child — the content wrapper.
  // The scroll container itself has a fixed (`flex-1`) box; its size
  // doesn't change when children grow. The wrapper does grow, and its
  // border-box growth is what pushes `scrollHeight` up.
  const content = el.firstElementChild as HTMLElement | null
  if (!content) return () => {}

  let userIntervened = false
  const markIntervened = () => { userIntervened = true }
  el.addEventListener("wheel", markIntervened, { passive: true })
  el.addEventListener("touchstart", markIntervened, { passive: true })

  // Skip the RO's synchronous initial callback (fired once with the
  // current size at observe() time) — otherwise we'd re-run `action`
  // against the pre-growth height and waste a frame.
  let firstCallback = true
  let rafId: number | null = null
  const scheduleAction = () => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (userIntervened) return
      action()
    })
  }
  const ro = new ResizeObserver(() => {
    if (firstCallback) { firstCallback = false; return }
    scheduleAction()
  })
  ro.observe(content)

  const timeoutId = window.setTimeout(() => {
    ro.disconnect()
  }, ASYNC_GROWTH_WINDOW_MS)

  return () => {
    el.removeEventListener("wheel", markIntervened)
    el.removeEventListener("touchstart", markIntervened)
    if (rafId !== null) cancelAnimationFrame(rafId)
    window.clearTimeout(timeoutId)
    ro.disconnect()
  }
}

/**
 * Owns the message-list scroll container ref and every automatic
 * scroll-anchor decision (mount / self-send / peer-follow / prepend /
 * hero-swap) plus the "↓ N below" pill's `belowCount`. Does NOT own
 * `jumpTo` (scrolling to an arbitrary message on reply-pill click) — that's
 * a user-triggered imperative action, not part of the automatic anchor
 * state machine, and stays in `message-list.tsx` (importing `cssEscape`
 * from this module for its own `[data-msg-id]` lookup).
 *
 * No `channelId`/`dmId` reset param: `<MessageList>` is still keyed by
 * `channelId`/`dmId` at the page level (see Phase 4 — the loading↔loaded
 * remount was the bug being fixed, not the channel-switch remount, which
 * stays and already gives this hook a fresh instance — and therefore
 * fresh internal state — on every genuine channel switch for free).
 */
export function useScrollAnchor({
  messages,
  newDividerBefore,
  initialScrollReady,
  hasMore,
  hasMoreNewer,
  viewerUserId,
}: {
  messages: ScrollAnchorMessage[]
  newDividerBefore?: string
  initialScrollReady: boolean
  hasMore?: boolean
  hasMoreNewer?: boolean
  viewerUserId?: string
}): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  belowCount: number
  scrollToBottom: () => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<ScrollAnchorState>(createScrollAnchorState())

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const { action, nextState } = decideScrollAction({
      state: stateRef.current,
      messages,
      newDividerBefore,
      initialScrollReady,
      hasMore,
      hasMoreNewer,
      viewerUserId,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    })
    stateRef.current = nextState

    switch (action.type) {
      case "mount": {
        let doAction: () => void
        // Prefer the NEW divider itself — it's a thin line, not the whole
        // row. Centering on the row (date divider + full message content)
        // instead visibly biases the divider toward the top of that taller
        // box once the anchor message has an attachment/long text/thread
        // preview. Only one `[data-new-divider]` is ever rendered per list,
        // so this doesn't need to be scoped to `newDividerBefore`'s row.
        // Falls back to the row itself when there's no divider to find
        // (e.g. first-visit anchoring on the first non-self message).
        const target = action.newDividerBefore
          ? el.querySelector<HTMLElement>("[data-new-divider]")
          ?? el.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(action.newDividerBefore)}"]`)
          : null
        if (target) {
          // Compute scrollTop manually rather than use `scrollIntoView({
          // block: "center" })`. The scroll root's content lives inside a
          // `flex justify-end min-h-full` wrapper; some engines interpret
          // `block: "center"` against that wrapper's flex flow rather than
          // the scroll root's viewport, and the row lands at the top of
          // the viewport instead of the middle. Bounding-rect delta works
          // regardless of offsetParent since it's viewport-space math.
          doAction = () => {
            const targetRect = target.getBoundingClientRect()
            const scrollRect = el.getBoundingClientRect()
            const targetTopInScroller = targetRect.top - scrollRect.top + el.scrollTop
            const desired = targetTopInScroller - (el.clientHeight - target.offsetHeight) / 2
            el.scrollTop = Math.max(0, desired)
          }
        } else {
          doAction = () => el.scrollTo({ top: el.scrollHeight })
        }
        doAction()
        return watchAsyncGrowth(el, doAction)
      }
      case "scrollToBottom": {
        // Instant, not smooth — `behavior: "smooth"` conflicts with the RO
        // re-pins in `watchAsyncGrowth` below: the browser's ongoing smooth
        // animation and a subsequent instant scrollTo race, and on some
        // engines the smooth animation "wins" by continuing to its stored
        // target after the instant jump lands, snapping the view back up.
        const doAction = () => el.scrollTo({ top: el.scrollHeight })
        doAction()
        return watchAsyncGrowth(el, doAction)
      }
      case "compensateDelta": {
        el.scrollTop = el.scrollTop + action.delta
        // Unlike mount/scrollToBottom (idempotent — each call recomputes an
        // absolute target), this compensation is incremental. If the
        // prepended older messages contain an image/avatar that decodes
        // asynchronously, the top block keeps growing AFTER this synchronous
        // adjustment — with no further correction, that later growth would
        // still shove the viewer's current row down. Track the height right
        // after this compensation and, on each subsequent async-growth tick,
        // add only the NEW growth since the last tick (not the original
        // `delta` again).
        let lastHeight = el.scrollHeight
        const doAction = () => {
          const grew = el.scrollHeight - lastHeight
          if (grew > 0) el.scrollTop = el.scrollTop + grew
          lastHeight = el.scrollHeight
        }
        return watchAsyncGrowth(el, doAction)
      }
      case "none":
        return undefined
    }
  }, [messages, newDividerBefore, initialScrollReady, hasMore, hasMoreNewer, viewerUserId])

  // "↓ N below" pill count. Recomputed on scroll, on messages change, and
  // via a ResizeObserver so appended rows update the badge even without a
  // scroll event. `0` means the user is at the bottom (or the list fits
  // entirely in the viewport) — the button hides. Shares `NEAR_BOTTOM_PX`
  // with the peer-follow decision above (previously an independent 8px
  // threshold that disagreed with peer-follow's 100px).
  const [belowCount, setBelowCount] = useState(0)
  const recomputeBelow = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setBelowCount(0)
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < NEAR_BOTTOM_PX) {
      setBelowCount(0)
      return
    }
    const rows = el.querySelectorAll<HTMLElement>("[data-msg-id]")
    const viewportBottom = el.scrollTop + el.clientHeight
    let count = 0
    for (const row of rows) {
      if (row.offsetTop >= viewportBottom) count++
    }
    setBelowCount(count)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    recomputeBelow()
    el.addEventListener("scroll", recomputeBelow, { passive: true })
    const ro = new ResizeObserver(recomputeBelow)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", recomputeBelow)
      ro.disconnect()
    }
  }, [recomputeBelow, messages.length])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  return { scrollRef, belowCount, scrollToBottom }
}
