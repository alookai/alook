"use client"

import { create } from "zustand"
import type React from "react"

/**
 * Zustand store for community client-only state.
 *
 * This owns the state that never round-trips through TanStack Query — the
 * "which server/channel is focused" pointers, timer maps that need lifetime
 * management, and the UI-handler bridge that lets deep components ask
 * ancestors to open modals / navigate.
 *
 * WS-live-patched state (presence, seen-message dedup) lives in the sibling
 * `./ws.ts` store to keep the concerns separate: this store is written by
 * user interactions, that store is written by socket events.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Loop-breaker rulebook (read before adding a store slice or a subscriber)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The community tree wires `useEffect` writers to Zustand subscribers to
 * TanStack Query caches, and the surface is wide enough that a subtle
 * reference-instability bug in one hook can loop the whole subtree. Every
 * rule below is a scar from a real crash — keep them intact.
 *
 * 1. Effect deps must be reference-stable across renders.
 *    Raw literals, `useCallback([], [])`, `useRef.current`, module-scoped
 *    constants (see `Object.freeze([])` fallbacks in `hooks/community/*`),
 *    and Zustand setters are all fine — their identity never shifts.
 *    Un-memoized derivations, `useMemo(..., [subscriber])`, and inline
 *    object literals are not — they churn on every re-render and re-fire
 *    the effect that depends on them.
 *
 * 2. Store setters should no-op on identical state.
 *    Zustand notifies every subscriber on `set(...)` regardless of whether
 *    the value actually changed. Guard writes with a content-equality
 *    check (see `subscribe` / `unsubscribe` below, and `hydratePresence` /
 *    `resetPresence` in `./ws.ts`). Otherwise a subscriber in the same
 *    subtree re-renders, shifts a dep, and re-invokes the setter — loop.
 *
 * 3. Selectors for "handler-shaped" state should return a module-scoped
 *    stable proxy. Handlers are events, not reactive state — callers
 *    should INVOKE them, not re-render when they change. `useUiHandlers`
 *    below is the pattern: a frozen object whose methods read `getState()`
 *    at call time, so registering new handlers never re-renders the tree.
 *
 * 4. Effects that write to a store slot should NOT depend on subscribers
 *    of that slot. If the write goes through a subscriber that lives in
 *    the effect's own subtree, the two are cyclically coupled and any dep
 *    instability will loop. Break the cycle by reading the current value
 *    off `useCommunityStore.getState()` inside the effect body instead of
 *    subscribing to it.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type CurrentChannelMeta = {
  name: string
  parentChannelId: string | null
  parentMessageId?: string | null
}

type CommunitySubscription = {
  channelId?: string
  dmConversationId?: string
}

type CommunityUiHandlers = {
  previewImage?: (url: string) => void
  openProfile?: (name: string, e: React.MouseEvent) => void
  goBackMobile?: () => void
}

type Timer = ReturnType<typeof setTimeout>

export type CommunityStoreState = {
  // Navigation pointers
  currentServerId: string | null
  currentChannelId: string | null
  currentChannelMeta: CurrentChannelMeta | null

  // Typing indicators (viewer-facing set + timers to auto-expire)
  typingUsers: string[]
  typingTimers: Map<string, Timer>
  // Rate-limit for typing.start emissions the viewer sends outbound; keyed
  // by channelId/dmId so switching contexts doesn't cross-throttle.
  lastTypingSent: Map<string, number>

  // Optimistic reaction toggles — timer + originalMe so we can roll back.
  reactionTimers: Map<string, { timer: Timer; originalMe: boolean }>

  // Machine pairing in flight (raw token id awaiting activate).
  pendingMachineTokenId: string | null

  // What the WS handler should treat as "focused" for setQueryData vs
  // invalidate routing.
  subscription: CommunitySubscription

  // UI-handler bridge — deep children register handlers, callers invoke
  // through the store rather than via prop drilling.
  uiHandlers: CommunityUiHandlers

  // ── Actions ─────────────────────────────────────────────────────────────
  setCurrentServerId: (id: string | null) => void
  setCurrentChannelId: (id: string | null) => void
  setCurrentChannelMeta: (meta: CurrentChannelMeta | null) => void
  subscribe: (target: CommunitySubscription) => void
  unsubscribe: () => void
  setPendingMachineTokenId: (tokenId: string | null) => void
  registerUiHandlers: (handlers: CommunityUiHandlers) => void
  reset: () => void
}

// ── Store ────────────────────────────────────────────────────────────────────

const initialState = (): Pick<
  CommunityStoreState,
  | "currentServerId"
  | "currentChannelId"
  | "currentChannelMeta"
  | "typingUsers"
  | "typingTimers"
  | "lastTypingSent"
  | "reactionTimers"
  | "pendingMachineTokenId"
  | "subscription"
  | "uiHandlers"
> => ({
  currentServerId: null,
  currentChannelId: null,
  currentChannelMeta: null,
  typingUsers: [],
  typingTimers: new Map(),
  lastTypingSent: new Map(),
  reactionTimers: new Map(),
  pendingMachineTokenId: null,
  subscription: {},
  uiHandlers: {},
})

export const useCommunityStore = create<CommunityStoreState>((set, get) => ({
  ...initialState(),

  setCurrentServerId: (id) => set({ currentServerId: id }),

  setCurrentChannelId: (id) => set({ currentChannelId: id }),

  setCurrentChannelMeta: (meta) => set({ currentChannelMeta: meta }),

  subscribe: (target) => {
    // Bail if the target is the same as the currently focused subscription.
    // `useCommunitySubscription` selects the object itself, so a naive
    // `set({ subscription: { ...target } })` on every mount would produce a
    // fresh reference each call and force every subscriber to re-render even
    // when nothing changed. Deep-compare the two known keys; only write on a
    // real diff.
    const prev = get().subscription
    if (
      prev.channelId === target.channelId &&
      prev.dmConversationId === target.dmConversationId
    ) {
      return
    }
    set({ subscription: { ...target } })
  },

  unsubscribe: () => {
    // Same reasoning as `subscribe` — don't churn the reference if it's
    // already empty.
    const prev = get().subscription
    if (!prev.channelId && !prev.dmConversationId) return
    set({ subscription: {} })
  },

  setPendingMachineTokenId: (tokenId) =>
    set({ pendingMachineTokenId: tokenId }),

  registerUiHandlers: (handlers) =>
    set({ uiHandlers: { ...get().uiHandlers, ...handlers } }),

  reset: () => {
    // Flush any pending mark-channel-read PUTs before we wipe local state so
    // the last-read pointer isn't stranded in the 500ms debounce window
    // (sign-out, hard-reset, tab close). Dynamic import avoids a circular
    // dependency: `mutations/messages.ts` already imports this store, so a
    // static import here would form a cycle. Fire-and-forget is fine — the
    // PUTs go out under the still-live auth cookie.
    void import("@/hooks/community/mutations/messages").then((m) =>
      m.flushPendingReads(),
    )
    // Fire-and-forget: clear every outstanding timer so nothing lingers past
    // sign-out or a hard-reset.
    const { typingTimers, reactionTimers } = get()
    typingTimers.forEach((t) => clearTimeout(t))
    reactionTimers.forEach(({ timer }) => clearTimeout(timer))
    set(initialState())
  },
}))

// ── Selectors ────────────────────────────────────────────────────────────────

export const useCurrentChannelId = () =>
  useCommunityStore((s) => s.currentChannelId)

export const useCurrentChannelMeta = () =>
  useCommunityStore((s) => s.currentChannelMeta)

/**
 * UI handlers are event callbacks, not reactive state — consumers should
 * INVOKE them, not re-render when they change. Returning a stable object
 * that reads `getState()` on each call keeps the store from becoming a
 * render-cascade choke point.
 *
 * If a caller needs the handlers reactively (they don't, today), swap
 * this for `useCommunityStore((s) => s.uiHandlers)` and accept the
 * re-render tax.
 */
const stableUiHandlers: CommunityUiHandlers = {
  previewImage: (url) => useCommunityStore.getState().uiHandlers.previewImage?.(url),
  openProfile: (name, e) => useCommunityStore.getState().uiHandlers.openProfile?.(name, e),
  goBackMobile: () => useCommunityStore.getState().uiHandlers.goBackMobile?.(),
}
export const useUiHandlers = () => stableUiHandlers

export const usePendingMachineTokenId = () =>
  useCommunityStore((s) => s.pendingMachineTokenId)
