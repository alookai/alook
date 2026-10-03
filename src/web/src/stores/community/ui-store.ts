import { createStore } from "@tanstack/store"
import type React from "react"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { CommunityOnboardingState } from "@/lib/community-onboarding"

// ── Types ────────────────────────────────────────────────────────────────────

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

export type CommunityUiHandlers = {
  previewImage?: (image: ImagePreview) => void
  previewAttachment?: (attachment: FileAttachment) => void
  openProfile?: (name: string, e: React.MouseEvent, discriminator?: string, userId?: string) => void
  goBackMobile?: () => void
  navigatePath?: (href: string) => void
  replacePath?: (href: string) => void
  // Jump to message `seq` within the CURRENT DM. Channel surfaces provide the
  // same behavior through a pane-local context so two visible split panes never
  // compete for this global slot. A same-scope message ref pill invokes it when
  // the message is loaded; otherwise its owning pane opens message context.
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
  // Fallback for surfaces without a pane-local message-navigation context.
  // Channel panes own this behavior locally; a message ref's intent remains
  // "see that message's context", not "go to that channel" (Gus #417). The
  // sheet resolves the target channel's seq→id + surrounding
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

function samePendingReply(left: PendingReply | null, right: PendingReply | null): boolean {
  return left === right || (
    left !== null &&
    right !== null &&
    left.channelId === right.channelId &&
    left.target.id === right.target.id &&
    left.target.authorName === right.target.authorName &&
    left.target.text === right.target.text
  )
}

type Timer = ReturnType<typeof setTimeout>

type CommunityStoreState = {
  onboardingState: CommunityOnboardingState | null
  // Navigation pointers
  currentServerId: string | null
  currentChannelId: string | null

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
  | "onboardingState"
  | "currentChannelId"
  | "typingByScope"
  | "typingTimers"
  | "lastTypingSent"
  | "pendingMachineTokenId"
  | "pendingReply"
  | "secondaryChannelOwner"
  | "subscription"
  | "uiHandlers"
> => ({
  onboardingState: null,
  currentServerId: null,
  currentChannelId: null,
  typingByScope: new Map(),
  typingTimers: new Map(),
  lastTypingSent: new Map(),
  pendingMachineTokenId: null,
  pendingReply: null,
  secondaryChannelOwner: null,
  subscription: {},
  uiHandlers: {},
})

export function createCommunityStore() {
  return createStore<ReturnType<typeof initialState>, Pick<CommunityStoreState, "setCurrentServerId" | "setCurrentChannelId" | "subscribe" | "claimSecondaryChannel" | "releaseSecondaryChannel" | "unsubscribe" | "setPendingMachineTokenId" | "setPendingReply" | "registerUiHandlers" | "reset">>(initialState(), ({ setState, get }) => ({

  setCurrentServerId: (id) => {
    if (get().currentServerId === id) return
    setState((state) => ({ ...state, ...{ currentServerId: id } }))
  },

  setCurrentChannelId: (id) => {
    if (get().currentChannelId === id) return // no-op on identical value
    setState((state) => ({ ...state, ...{ currentChannelId: id } }))
  },

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
    setState((state) => ({ ...state, ...{
      subscription: {
        ...target,
        ...(prev.secondaryChannelId ? { secondaryChannelId: prev.secondaryChannelId } : {}),
      },
    } }))
  },

  claimSecondaryChannel: (owner, id) => {
    const prev = get().subscription
    if (get().secondaryChannelOwner === owner && prev.secondaryChannelId === id) return
    setState((state) => ({ ...state, ...{
      subscription: {
        ...prev,
        secondaryChannelId: id,
      },
      secondaryChannelOwner: owner,
    } }))
  },

  releaseSecondaryChannel: (owner) => {
    if (get().secondaryChannelOwner !== owner) return
    const { secondaryChannelId: _secondaryChannelId, ...subscription } = get().subscription
    setState((state) => ({ ...state, ...{ subscription, secondaryChannelOwner: null } }))
  },

  unsubscribe: () => {
    // Same reasoning as `subscribe` — don't churn the reference if it's
    // already empty.
    const prev = get().subscription
    if (!prev.channelId && !prev.secondaryChannelId && !prev.dmConversationId) return
    setState((state) => ({ ...state, ...{ subscription: {}, secondaryChannelOwner: null } }))
  },

  setPendingMachineTokenId: (tokenId) => {
    if (get().pendingMachineTokenId === tokenId) return
    setState((state) => ({ ...state, ...{ pendingMachineTokenId: tokenId } }))
  },

  setPendingReply: (reply) => {
    if (samePendingReply(get().pendingReply, reply)) return
    setState((state) => ({ ...state, ...{ pendingReply: reply } }))
  },

  registerUiHandlers: (handlers) => {
    const current = get().uiHandlers
    const entries = Object.entries(handlers) as Array<[
      keyof CommunityUiHandlers,
      CommunityUiHandlers[keyof CommunityUiHandlers],
    ]>
    if (entries.every(([key, handler]) => current[key] === handler)) return
    setState((state) => ({ ...state, ...{ uiHandlers: { ...current, ...handlers } } }))
  },

  reset: () => {
    const { typingTimers } = get()
    typingTimers.forEach((t) => clearTimeout(t))
    setState((state) => ({ ...state, ...initialState() }))
  },
  }))
}
