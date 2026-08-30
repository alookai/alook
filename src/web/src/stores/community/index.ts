"use client"

import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import type React from "react"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"

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
 *    check (see `subscribe` / `unsubscribe` below). Otherwise a subscriber in the same
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
  creatorId?: string | null
}

type CommunitySubscription = {
  channelId?: string
  // A second visible channel in desktop thread split view. This is never a
  // second transport subscription: the user socket already receives both;
  // it only tells the client projector that both mounted feeds are focused.
  secondaryChannelId?: string
  // The focused DM's channel id. A DM is a channel now; the slot name is kept
  // only to distinguish "the focused channel is a DM" for the WS handler's
  // cache-routing (see `use-community-ws.ts`).
  dmConversationId?: string
}

type CommunityUiHandlers = {
  previewImage?: (image: ImagePreview) => void
  previewAttachment?: (attachment: FileAttachment) => void
  openProfile?: (name: string, e: React.MouseEvent, discriminator?: string, userId?: string) => void
  goBackMobile?: () => void
  navigatePath?: (href: string) => void
  replacePath?: (href: string) => void
  // Jump to message `seq` within the CURRENT channel/DM — the page registers
  // this (message already loaded → scroll to it; otherwise open the context
  // sheet, which resolves seq→id server-side). A same-channel message ref pill
  // (`/server/channel#N` where the channel is the open one) invokes it so
  // clicking still scrolls to the message — the behavior the bare-`#N` pill had
  // before message-ref-upgrade.md removed it.
  jumpToSeq?: (seq: number) => void
  cancelPendingNavigation?: () => void
  // Navigate to a server (channelId omitted) or a channel. Registered by the
  // shell (shell-frame) where the router is the live App-Router instance.
  // Channel/server-ref pills call this INSTEAD of a subtree `useRouter()`:
  // those pills render deep inside the memoized Streamdown message tree, where
  // `useRouter().push` is a no-op (the ref pill's cross-channel click silently
  // did nothing — a pre-existing bug the full-path refs exposed). The shell
  // router works (rail clicks navigate through it), so route through the bridge.
  // (A message ref does NOT navigate — it opens the context sheet in place via
  // `openMessageContext`; only a plain channel/server ref navigates.)
  navigate?: (serverId: string, channelId?: string) => void
  // Open the message context side sheet IN PLACE for a message ref — the
  // channel page registers this. A message ref's intent is "see that message's
  // context", not "go to that channel" (Gus #417), so clicking it never
  // navigates: the sheet resolves the target channel's seq→id + surrounding
  // messages (via the access-checked read path — a private channel the viewer
  // can't see returns not-found, no leak) and shows them without leaving the
  // current channel. `label` is the source channel's display name for the sheet
  // header (passed in so the sheet needn't refetch channel metadata).
  openMessageContext?: (target: { serverId: string; channelId: string; label: string; seq: number }) => void
}

/** A reply target handed off across a channel navigation. Clicking Reply on a
 * CROSS-channel message-context sheet can't seed the current channel's composer
 * (you'd stamp a reply to a message in another channel). Instead the sheet
 * stashes the target here + navigates to that message's channel; the
 * destination channel page consumes it on mount and seeds ITS composer, so the
 * reply lands in the right channel (Gus #449/#452). */
type PendingReply = {
  channelId: string
  target: { id: string; authorName: string; text: string }
}

type Timer = ReturnType<typeof setTimeout>

export type CommunityStoreState = {
  // Navigation pointers
  currentServerId: string | null
  currentChannelId: string | null
  currentChannelMeta: CurrentChannelMeta | null

  // Typing indicators, keyed by conversation scope so a DM typer never leaks
  // into a channel view (and vice versa). `scopeKey` is `dm:<id>` / `ch:<id>`
  // (see `use-community-ws.ts`). Each scope maps its typing userIds to the
  // display name the typing event carried (`null` when the event didn't
  // include one — an older server — so the consumer falls back to roster
  // resolution). `typingTimers` auto-expires each `(scope, user)` pair.
  typingByScope: Map<string, Map<string, string | null>>
  typingTimers: Map<string, Timer>
  // Rate-limit for typing.start emissions the viewer sends outbound; keyed
  // by channelId/dmId so switching contexts doesn't cross-throttle.
  lastTypingSent: Map<string, number>

  // Optimistic reaction toggles — timer + originalMe so we can roll back.
  reactionTimers: Map<string, { timer: Timer; originalMe: boolean }>

  // Machine pairing in flight (raw token id awaiting activate).
  pendingMachineTokenId: string | null

  // A reply target handed off across a channel navigation (cross-channel sheet
  // Reply → navigate → destination page seeds its composer). See `PendingReply`.
  pendingReply: PendingReply | null

  secondaryChannelOwner: symbol | null

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
  subscribe: (target: Pick<CommunitySubscription, "channelId" | "dmConversationId">) => void
  claimSecondaryChannel: (owner: symbol, id: string) => void
  releaseSecondaryChannel: (owner: symbol) => void
  unsubscribe: () => void
  setPendingMachineTokenId: (tokenId: string | null) => void
  setPendingReply: (reply: PendingReply | null) => void
  registerUiHandlers: (handlers: CommunityUiHandlers) => void
  reset: () => void
}

// ── Store ────────────────────────────────────────────────────────────────────

const initialState = (): Pick<
  CommunityStoreState,
  | "currentServerId"
  | "currentChannelId"
  | "currentChannelMeta"
  | "typingByScope"
  | "typingTimers"
  | "lastTypingSent"
  | "reactionTimers"
  | "pendingMachineTokenId"
  | "pendingReply"
  | "secondaryChannelOwner"
  | "subscription"
  | "uiHandlers"
> => ({
  currentServerId: null,
  currentChannelId: null,
  currentChannelMeta: null,
  typingByScope: new Map(),
  typingTimers: new Map(),
  lastTypingSent: new Map(),
  reactionTimers: new Map(),
  pendingMachineTokenId: null,
  pendingReply: null,
  secondaryChannelOwner: null,
  subscription: {},
  uiHandlers: {},
})

export const useCommunityStore = create<CommunityStoreState>((set, get) => ({
  ...initialState(),

  setCurrentServerId: (id) => set({ currentServerId: id }),

  setCurrentChannelId: (id) => {
    if (get().currentChannelId === id) return // no-op on identical value
    set({ currentChannelId: id })
  },

  setCurrentChannelMeta: (meta) => set({ currentChannelMeta: meta }),

  subscribe: (target) => {
    // Bail if the target is the same as the currently focused subscription.
    // `useCommunitySubscription` selects the object itself, so a naive
    // `set({ subscription: { ...target } })` on every mount would produce a
    // fresh reference each call and force every subscriber to re-render even
    // when nothing changed. Deep-compare the two known keys; only write on a
    // real diff. Secondary focus has a separate owner and lifecycle, so route
    // subscriptions preserve it rather than racing the split layout effect.
    const prev = get().subscription
    if (
      prev.channelId === target.channelId &&
      prev.dmConversationId === target.dmConversationId
    ) {
      return
    }
    set({
      subscription: {
        ...target,
        ...(prev.secondaryChannelId ? { secondaryChannelId: prev.secondaryChannelId } : {}),
      },
    })
  },

  claimSecondaryChannel: (owner, id) => {
    const prev = get().subscription
    if (get().secondaryChannelOwner === owner && prev.secondaryChannelId === id) return
    set({
      subscription: {
        ...prev,
        secondaryChannelId: id,
      },
      secondaryChannelOwner: owner,
    })
  },

  releaseSecondaryChannel: (owner) => {
    if (get().secondaryChannelOwner !== owner) return
    const { secondaryChannelId: _secondaryChannelId, ...subscription } = get().subscription
    set({ subscription, secondaryChannelOwner: null })
  },

  unsubscribe: () => {
    // Same reasoning as `subscribe` — don't churn the reference if it's
    // already empty.
    const prev = get().subscription
    if (!prev.channelId && !prev.secondaryChannelId && !prev.dmConversationId) return
    set({ subscription: {}, secondaryChannelOwner: null })
  },

  setPendingMachineTokenId: (tokenId) =>
    set({ pendingMachineTokenId: tokenId }),

  setPendingReply: (reply) => set({ pendingReply: reply }),

  registerUiHandlers: (handlers) =>
    set({ uiHandlers: { ...get().uiHandlers, ...handlers } }),

  reset: () => {
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
  previewAttachment: (attachment) => useCommunityStore.getState().uiHandlers.previewAttachment?.(attachment),
  openProfile: (name, e, discriminator, userId) =>
    useCommunityStore.getState().uiHandlers.openProfile?.(name, e, discriminator, userId),
  goBackMobile: () => useCommunityStore.getState().uiHandlers.goBackMobile?.(),
  navigatePath: (href) => useCommunityStore.getState().uiHandlers.navigatePath?.(href),
  replacePath: (href) => useCommunityStore.getState().uiHandlers.replacePath?.(href),
  jumpToSeq: (seq) => useCommunityStore.getState().uiHandlers.jumpToSeq?.(seq),
  cancelPendingNavigation: () => useCommunityStore.getState().uiHandlers.cancelPendingNavigation?.(),
  navigate: (serverId, channelId) => useCommunityStore.getState().uiHandlers.navigate?.(serverId, channelId),
  openMessageContext: (target) => useCommunityStore.getState().uiHandlers.openMessageContext?.(target),
}
export const useUiHandlers = () => stableUiHandlers

export const usePendingMachineTokenId = () =>
  useCommunityStore((s) => s.pendingMachineTokenId)

// Module-scoped stable empty array — avoids allocating a fresh `[]` on every
// selector run for the common no-typing case.
const EMPTY_TYPING: string[] = []
// Stable empty object for the no-typing case, so `useShallow` doesn't churn.
const EMPTY_TYPING_NAMES: Record<string, string | null> = {}

/**
 * The userIds currently typing in a given conversation scope (`dm:<id>` /
 * `ch:<id>`), or an empty array. `useShallow` compares the returned array
 * element-wise, so a page only re-renders when THIS scope's membership
 * changes — typing activity in other conversations doesn't churn it.
 */
export const useTypingUsersForScope = (scopeKey: string) =>
  useCommunityStore(
    useShallow((s) => {
      const map = s.typingByScope.get(scopeKey)
      return map ? Array.from(map.keys()) : EMPTY_TYPING
    }),
  )

/**
 * The display names the typing events carried for a scope, keyed by userId
 * (`null` when the event didn't include one). Consumers prefer this name and
 * fall back to roster resolution only when it's absent — the fix for
 * "Unknown member is typing" when the typer isn't in the loaded roster page.
 * Returned as a plain object so `useShallow` can compare it entry-wise.
 */
export const useTypingNamesForScope = (scopeKey: string) =>
  useCommunityStore(
    useShallow((s) => {
      const map = s.typingByScope.get(scopeKey)
      if (!map) return EMPTY_TYPING_NAMES
      const out: Record<string, string | null> = {}
      for (const [id, name] of map) out[id] = name
      return out
    }),
  )
