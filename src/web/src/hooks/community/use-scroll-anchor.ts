import { useCallback, useLayoutEffect, useRef } from "react"
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import { estimateRowHeight, computeBelowCount, type FlatItem } from "@/components/community/message-list-items"

// Virtualized rewrite of message-list's scroll-anchoring logic. The
// pre-virtualization version (see git history) hand-rolled 4 branches —
// mount / self-send-peer-follow / older-prepend-compensation / hero-swap-
// compensation — verified against `record-debt-community-messages.md`
// findings #2/#10 (two disagreeing "near bottom" thresholds, a same-commit
// double-write race, a silently-unhandled compound case).
//
// This version delegates OLDER-PREPEND compensation entirely to
// `@tanstack/react-virtual`'s `anchorTo: "end"` (verified against the
// installed `virtual-core@3.17.3` source: its `setOptions` anchor-preserving
// branch fires on any edge-key/count change on a non-initial commit — exactly
// what `fetchOlder` prepending rows produces). `decideScrollAction` below
// therefore only covers the 2 behaviors the library does NOT provide:
// mount-time positioning and self-send/peer-follow. Hero-swap compensation
// is also NOT delegated to the library (`scrollMargin` shifts the
// measurement coordinate system only — verified it never triggers a
// `scrollOffset` write) and is handled by the separate, narrower
// `computeHeroScrollCompensation` below plus a dedicated `ResizeObserver`
// on the hero wrapper (see `useScrollAnchor`'s hero-tracking effect) — NOT
// the old catch-all `watchAsyncGrowth`, which is deleted along with its
// row-level image-decode case (native `resizeItem`/`applyScrollAdjustment`
// in the installed library replaces that one).
//
// `followOnAppend` is deliberately left OFF in the virtualizer config (see
// `useScrollAnchor`) — turning it on would let the library ALSO call
// `scrollToEnd()` on any append where `isAtEnd()` was already true, racing
// with this hook's own explicit self-send/peer-follow `scrollToEnd()` call
// in the same commit (same class of same-commit double-write the debt
// record already flagged once). `isAtEnd()` is still reused here as a cheap
// boolean read — only the ACT of scrolling stays single-sourced.

// Shared "near bottom" threshold. Also passed as the virtualizer's own
// `scrollEndThreshold` config value (see `useScrollAnchor`) — NOT purely
// cosmetic: `scrollEndThreshold` independently gates the library's native
// `resizeItem` above-viewport compensation (defaults to 1px otherwise).
export const NEAR_BOTTOM_PX = 100

export interface ScrollAnchorMessage {
  id: string
  authorId?: string
}

export interface ScrollAnchorState {
  didInitialScroll: boolean
  lastTailId: string | null
}

export function createScrollAnchorState(): ScrollAnchorState {
  return {
    didInitialScroll: false,
    lastTailId: null,
  }
}

export interface DecideScrollActionInput {
  state: ScrollAnchorState
  messages: ScrollAnchorMessage[]
  newDividerBefore?: string
  initialScrollReady: boolean
  // Whether the hero block's real height has been measured at least once
  // (the caller's `ResizeObserver` effect has fired). Gates mount the same
  // way `initialScrollReady` does: firing mount while this is still false
  // means `scrollMargin` is still its default 0, so `scrollToIndex`'s
  // offset math (align: "center", for the NEW-divider case) targets the
  // wrong scrollTop — and the virtualizer's own scroll-reconcile loop
  // stabilizes on that wrong value within a frame, well before the hero's
  // real height (a separate React state update) lands. Observed as: page
  // loads, view flashes at the tail then snaps to the top hero, and unread
  // messages near the true tail never enter the viewport so
  // useChannelWatermark never advances the read pointer.
  heroMeasured: boolean
  hasMoreNewer?: boolean
  viewerUserId?: string
  // Whether the viewport was within NEAR_BOTTOM_PX of the end BEFORE this
  // commit's append — the caller reads this off `virtualizer.isAtEnd(NEAR_BOTTOM_PX)`.
  isAtEnd: boolean
}

type ScrollAction =
  | { type: "none" }
  | { type: "mount"; newDividerBefore: string | undefined }
  | { type: "scrollToEnd" }

export interface DecideScrollActionResult {
  action: ScrollAction
  nextState: ScrollAnchorState
}

/**
 * Pure decision function — given the previous anchor state and this
 * commit's inputs, decides AT MOST ONE scroll action, in priority order:
 *   1. Mount-time initial scroll (fires exactly once — covers BOTH the
 *      divider-center case and the plain "start at the end" case; neither
 *      is free with `anchorTo: "end"`, which only engages its
 *      anchor-preserving logic on options DIFFS, not the constructor's
 *      initial `setOptions` call).
 *   2. Self-send / peer-follow snap to end.
 * Older-prepend compensation and hero-swap compensation are NOT decided
 * here — see this file's module doc comment for where they moved. No DOM
 * access — the caller (the hook) executes the chosen action against the
 * real virtualizer. Exported for unit testing without DOM/hooks.
 */
export function decideScrollAction(input: DecideScrollActionInput): DecideScrollActionResult {
  const { state, messages, newDividerBefore, initialScrollReady, heroMeasured, hasMoreNewer, viewerUserId, isAtEnd } = input

  const nextTail = messages[messages.length - 1]?.id ?? null
  const nextLen = messages.length

  const baseNextState: ScrollAnchorState = {
    didInitialScroll: state.didInitialScroll,
    lastTailId: nextTail,
  }

  // Channel/DM cleared (or genuinely empty) — nothing to anchor, and RE-ARM
  // the mount one-shot gate. The list can transiently empty AFTER a
  // successful initial scroll when a live path invalidates the message query
  // mid-mount — the observed trigger is `useCommunityWs`'s `handleReconnect`,
  // which fires ~1.5s into a fresh load (a StrictMode / refresh double-
  // connect makes the socket's `onReconnect` run once even on first paint)
  // and invalidates BOTH `channelMessages` and the `gcTime: 0`
  // `channelReadStateSnapshot`. That round-trips `messages` through `[]`
  // (itemCount 48 → 0 → 48, verified via live Playwright trace). Without
  // re-arming, the one-shot `didInitialScroll` gate stays consumed, so when
  // the rows return the mount scroll never re-fires and the view is left
  // parked at the top hero with the NEW divider off-screen — exactly the
  // "content → skeleton → content → stuck at hero" refresh bug. Re-arming
  // makes the next non-empty commit re-run the mount positioning.
  //
  // Safe for a genuine channel switch too: that path already gets a fresh
  // hook instance (keyed by channelId/dmId — see this hook's doc comment),
  // so this branch only ever matters for a same-scope transient empty.
  if (nextLen === 0) {
    return { action: { type: "none" }, nextState: { ...baseNextState, didInitialScroll: false } }
  }

  // 1. Mount-time initial scroll — fires exactly once. Bails (without
  // consuming the gate) until `initialScrollReady` — running before the
  // owner's async anchor (e.g. `useChannelReadStateSnapshot`) resolves
  // would silently snap to the bottom and burn the one-shot gate. Also
  // bails until `heroMeasured` — see this field's doc comment above for why
  // firing on a stale (default-0) scrollMargin silently mis-targets the
  // NEW-divider case.
  if (!state.didInitialScroll) {
    if (!initialScrollReady || !heroMeasured) {
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
      // self-send snap, not a misclassified no-op).
      return { action: { type: "scrollToEnd" }, nextState: baseNextState }
    }
    // Peer send: only follow if the loaded window is tail-attached to the
    // present (`hasMoreNewer` false) AND the viewer was already at/near the
    // bottom just BEFORE this append — otherwise leave the "↓ N" pill to
    // prompt them back down.
    if (!hasMoreNewer && isAtEnd) {
      return { action: { type: "scrollToEnd" }, nextState: baseNextState }
    }
  }

  return { action: { type: "none" }, nextState: baseNextState }
}

/**
 * Hero-swap scroll compensation. Unlike the deleted `olderPrepended`/
 * `heroSwap` delta-compensation branch this replaces, this is a plain
 * arithmetic delta between two known heights — not a `scrollHeight`-diff
 * read off the DOM — since the caller already tracks the hero wrapper's
 * measured height via `ResizeObserver` (see `useScrollAnchor`). Exported
 * for direct unit testing.
 */
export function computeHeroScrollCompensation(prevHeroHeight: number, nextHeroHeight: number): number {
  return nextHeroHeight - prevHeroHeight
}

/**
 * Look up a message's position in the flattened item array by id — the
 * virtualized replacement for `jumpTo`'s old
 * `querySelector('[data-msg-id="..."]')` DOM lookup, which only worked if
 * the target row happened to already be mounted. `virtualizer.scrollToIndex`
 * needs an INDEX, not a DOM node, so this walks `items` instead. Returns
 * `null` when the target isn't in the currently loaded page window — same
 * limitation the old DOM lookup had (it also required the row to be
 * loaded), just surfaced earlier/more explicitly. Never matches a divider
 * row. Exported for direct unit testing.
 */
export function findMessageIndex(items: FlatItem[], messageId: string): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === "message" && item.m.id === messageId) return i
  }
  return null
}

/**
 * Mount-time scroll target: the NEW divider's own row when present (it's a
 * thin line, not the whole message box — centering on the row instead
 * visibly biases the divider toward the top of that taller box once the
 * anchor message has an attachment/long text/thread preview), falling back
 * to the target message's own index when no divider item was flattened
 * (e.g. first-visit anchoring with no unread pointer to render a divider
 * for). Returns `null` if the target message isn't loaded.
 */
export function findMountScrollTargetIndex(items: FlatItem[], newDividerBefore: string): number | null {
  const msgIdx = findMessageIndex(items, newDividerBefore)
  if (msgIdx === null) return null
  const dividerIdx = items.findIndex((i) => i.kind === "new-divider")
  return dividerIdx !== -1 ? dividerIdx : msgIdx
}

/**
 * Projects the flattened item array down to just the id/authorId pairs
 * `decideScrollAction` needs (it only cares about the tail message's id
 * and author, not divider rows). Exported for direct unit testing.
 */
export function extractScrollAnchorMessages(items: FlatItem[]): ScrollAnchorMessage[] {
  const out: ScrollAnchorMessage[] = []
  for (const item of items) {
    if (item.kind === "message") out.push({ id: item.m.id, authorId: item.m.authorId })
  }
  return out
}

/**
 * Owns the message-list scroll container ref, the `useVirtualizer` instance,
 * and every automatic scroll-anchor decision (mount / self-send /
 * peer-follow / hero-swap) plus the "↓ N below" pill's `belowCount`. Older-
 * message prepend compensation is NOT decided here — it's delegated to the
 * virtualizer's own `anchorTo: "end"` config (see this file's module doc
 * comment for the source-verified rationale).
 *
 * `jumpTo` (scrolling to an arbitrary earlier message on reply-pill click)
 * DOES live here now, unlike the pre-virtualization hook — it needs direct
 * `virtualizer.scrollToIndex` access, which `message-list.tsx` has no other
 * reason to reach into the virtualizer instance for.
 *
 * No `channelId`/`dmId` reset param: `<MessageList>` is still keyed by
 * `channelId`/`dmId` at the page level, which gives this hook a fresh
 * instance — and therefore fresh internal state — on every genuine channel
 * switch for free.
 */
export function useScrollAnchor({
  items,
  newDividerBefore,
  initialScrollReady,
  hasMoreNewer,
  viewerUserId,
  heroHeight,
  heroMeasured,
}: {
  items: FlatItem[]
  newDividerBefore?: string
  initialScrollReady: boolean
  hasMoreNewer?: boolean
  viewerUserId?: string
  // Current measured height (px) of the non-virtualized hero block that
  // renders above the virtualized range (the "Beginning of the channel…"
  // copy or the thread-opener). Feeds the virtualizer's `scrollMargin` AND
  // the hand-rolled hero-swap compensation (see `computeHeroScrollCompensation`)
  // — `scrollMargin` alone does NOT preserve scroll position on its own,
  // verified against the installed virtual-core source.
  heroHeight: number
  // True once the caller's hero-height ResizeObserver has fired at least
  // once. Gates mount the same way `initialScrollReady` does — see
  // `DecideScrollActionInput.heroMeasured`'s doc comment for the bug this
  // prevents (mount firing on a stale, default-0 `scrollMargin`).
  heroMeasured: boolean
}): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  belowCount: number
  scrollToBottom: () => void
  jumpTo: (messageId: string) => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<ScrollAnchorState>(createScrollAnchorState())
  const messages = extractScrollAnchorMessages(items)

  // eslint-disable-next-line react-hooks/incompatible-library -- library limitation, same as member-list.tsx
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowHeight(items[index]),
    getItemKey: (index) => items[index].key,
    anchorTo: "end",
    // Deliberately OFF — see this file's module doc comment for the
    // same-commit double-`scrollToEnd()` race this avoids.
    followOnAppend: false,
    // NOT purely cosmetic even with followOnAppend off — independently
    // gates the library's native `resizeItem` above-viewport compensation
    // (the mechanism replacing the deleted `watchAsyncGrowth`'s row-level
    // image-decode case). Left at the library default (1px), that native
    // compensation would only fire when the user is within 1px of the
    // literal bottom.
    scrollEndThreshold: NEAR_BOTTOM_PX,
    scrollMargin: heroHeight,
    overscan: 8,
  })

  useLayoutEffect(() => {
    const { action, nextState } = decideScrollAction({
      state: stateRef.current,
      messages,
      newDividerBefore,
      initialScrollReady,
      heroMeasured,
      hasMoreNewer,
      viewerUserId,
      isAtEnd: virtualizer.isAtEnd(NEAR_BOTTOM_PX),
    })
    stateRef.current = nextState

    switch (action.type) {
      case "mount": {
        const idx = action.newDividerBefore ? findMountScrollTargetIndex(items, action.newDividerBefore) : null
        if (idx !== null) {
          virtualizer.scrollToIndex(idx, { align: "center" })
        } else {
          virtualizer.scrollToEnd()
        }
        return
      }
      case "scrollToEnd":
        virtualizer.scrollToEnd()
        return
      case "none":
        return
    }
    // messages/items share identity per render (extractScrollAnchorMessages
    // derives from items) — `items` alone is the correct dep, not a
    // secondary `messages` dep, avoiding a re-derivation-triggered re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, newDividerBefore, initialScrollReady, heroMeasured, hasMoreNewer, viewerUserId, virtualizer])

  // Hero-swap compensation — NOT delegated to `scrollMargin` (verified it
  // never triggers a `scrollOffset` write on its own). Tracks the hero's
  // height across renders and adjusts `el.scrollTop` by the delta whenever
  // it changes, holding the visually-anchored row in place. Narrower than
  // the deleted `watchAsyncGrowth`: only one input (a single number this
  // hook already receives as a prop), no ResizeObserver of its own needed
  // here — the caller (`message-list.tsx`) owns the hero's own
  // ResizeObserver and passes the resulting height in as `heroHeight`.
  const prevHeroHeightRef = useRef(heroHeight)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const delta = computeHeroScrollCompensation(prevHeroHeightRef.current, heroHeight)
    prevHeroHeightRef.current = heroHeight
    if (delta !== 0) el.scrollTop += delta
  }, [heroHeight])

  // "↓ N below" pill count — a plain arithmetic derivation from data
  // `getVirtualItems()` already exposes on every render, replacing the
  // pre-virtualization `recomputeBelow`'s DOM-row-walk
  // (`querySelectorAll("[data-msg-id]")` + `offsetTop` comparison).
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1
  const belowCount = virtualizer.isAtEnd(NEAR_BOTTOM_PX) ? 0 : computeBelowCount(items.length, lastVisibleIndex)

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToEnd({ behavior: "smooth" })
  }, [virtualizer])

  const jumpTo = useCallback((messageId: string) => {
    const idx = findMessageIndex(items, messageId)
    // Target not in the currently loaded page window — same limitation the
    // pre-virtualization `querySelector` lookup had (it also required the
    // row to be loaded); documented no-op, not a new failure mode.
    if (idx === null) return
    virtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" })
  }, [items, virtualizer])

  return { scrollRef, virtualizer, belowCount, scrollToBottom, jumpTo }
}
