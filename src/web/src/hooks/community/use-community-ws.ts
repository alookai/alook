"use client"

import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useUserWs } from "@/lib/use-user-ws"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import {
  handleMessageCreate,
  handleMessageEdited,
  handleMessageUpdated,
  handlePinEvent,
  handleReactionEvent,
} from "@/hooks/community/community-ws/message-events"
import {
  handleTypingStart,
  handleTypingStop,
} from "@/hooks/community/community-ws/typing-events"
import {
  handleCategoryEvent,
  handleChannelEvent,
  handleChildChannelCreate,
  handleChildChannelUpdate,
  handleInviteCreate,
  handleServerDelete,
  handleServerUpdate,
} from "@/hooks/community/community-ws/structure-tree-events"
import {
  handleChannelMemberEvent,
  handleMemberJoin,
  handleMemberLeave,
  handleMemberUpdate,
} from "@/hooks/community/community-ws/membership-events"
import {
  handleFriendEvent,
  handleMentionCreate,
  handleUnreadBump,
} from "@/hooks/community/community-ws/social-events"
import {
  handleBotAuditEvent,
  handleMachineCreated,
  handleMachineRemoved,
  handleMachineStatus,
  handleMachineUpdated,
  handlePresenceUpdate,
  handleStatusUpdate,
} from "@/hooks/community/community-ws/presence-machine-events"
import { reconcileCommunityWsReconnect } from "@/hooks/community/community-ws/reconnect"
import type {
  CommunityWsHandlerContext,
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"
import type { CommunityWsEvent } from "@alook/shared"
import { isCommunityEvent, TYPING_INDICATOR_THROTTLE_MS } from "@alook/shared"

export type {
  Subscription,
  UseCommunityWsOptions,
} from "@/hooks/community/community-ws/handler-context"

/**
 * Community WebSocket handler.
 *
 * Every event either patches the TanStack Query cache directly (fast — no
 * refetch) or invalidates a query key (slow — triggers refetch). The choice
 * is driven by the reconciliation table in `plans/21-community-tech-debt-pass-2.md`.
 *
 * State this hook owns *outside* the query cache:
 * - `useCommunityWsStore.onlineUserIds` — presence set, WS-only.
 * - `useCommunityWsStore.seenMessageIds` — dedup for `message.create`.
 * - `useCommunityStore.typingByScope` + `typingTimers` — typing indicator,
 *   keyed by conversation scope with per-(scope, user) auto-expire timers.
 * - `useCommunityStore.lastTypingSent` — outbound typing.start rate limit.
 *
 * The subscription (which channel/DM is focused) is read from
 * `useCommunityStore.subscription`, not from local component state — that
 * way any consumer can call `useCommunityStore.getState().subscribe(...)`
 * and the WS handler picks it up on the next event.
 */

// ── Constants ─────────────────────────────────────────────────────────────

// Debounce inbox invalidation so a busy channel doesn't fire one refetch per
// message. 500ms matches the mark-channel-read debounce so both fire once per
// message burst.
const INBOX_INVALIDATE_DEBOUNCE_MS = 500

// ── Public hook ────────────────────────────────────────────────────────────

// Module-level slot for the currently-active WS `send`. The root-mounted
// `useCommunityWs` writes into this on connect so free helpers below can
// dispatch typing events without needing to re-mount the hook (which would
// open a second WebSocket per consumer). Cleared on unmount.
let activeSend: ((msg: object) => void) | null = null

/** Testing hook — clears the module-scoped `activeSend` binding. */
export function _resetActiveSend_forTesting() {
  activeSend = null
}

/**
 * Subscribe to a channel/thread/DM. Free helper so any component can update
 * the focused subscription without holding a reference to `useCommunityWs`.
 */
export function communityWsSubscribe(target: Subscription) {
  useCommunityStore.getState().subscribe(target)
}

export function communityWsUnsubscribe() {
  useCommunityStore.getState().unsubscribe()
}

/**
 * Send a typing indicator. Client-side debounced at 8s per channelId (a DM is
 * a channel now, so its id is a channelId too). If no WS is connected, the
 * call is a no-op — subsequent connections don't retroactively fire missed
 * typings.
 */
export function communityWsSendTyping(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  const send = activeSend
  if (!send) return

  const now = Date.now()
  const map = useCommunityStore.getState().lastTypingSent
  const lastSent = map.get(key) || 0
  if (now - lastSent < TYPING_INDICATOR_THROTTLE_MS) return

  map.set(key, now)
  send({ type: "community:typing.start", channelId: key })
}

/**
 * Reset the outbound typing.start throttle for a channel. Sending a message
 * ends the current typing burst; the very next keystroke should re-emit
 * typing.start immediately, not wait out the 8s dedup window.
 */
export function communityWsResetTypingThrottle(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  useCommunityStore.getState().lastTypingSent.delete(key)
}

export function useCommunityWs(options?: UseCommunityWsOptions): void {
  const queryClient = useQueryClient()
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  useEffect(() => {
    viewerUserIdRef.current = options?.viewerUserId ?? null
  })

  // #3: the previous WS-driven auto-mark-read (a `useMarkChannelRead()` call
  // fired on every foreign-authored message in the focused channel) has
  // been removed. The IntersectionObserver in `useChannelWatermark` is now
  // authoritative — if a WS-delivered message actually becomes visible in
  // the viewport, IO advances the read pointer; if the user is scrolled up
  // reading history, the pointer stays put (which is the correct behavior).

  // Debounced inbox invalidation. Grouping repeated invalidations into one
  // refetch cycle keeps the popover from re-rendering on every message tick.
  const inboxDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInboxInvalidate = useCallback(() => {
    if (inboxDebounce.current) return
    inboxDebounce.current = setTimeout(() => {
      inboxDebounce.current = null
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      // A DM is a channel now, so a DM message arrives as `message.create`
      // with no discriminator distinguishing it from a channel message. Fold
      // the old `dm.new_message` DM-sidebar refresh in here: invalidate the
      // DM list too so an unread DM's preview/unread flag updates live. Cheap
      // — `communityKeys.dms()` is only observed under the `/c/me` layout, so
      // this is a no-op (marks stale, no refetch) while viewing a server
      // channel where the DM sidebar isn't mounted.
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
    }, INBOX_INVALIDATE_DEBOUNCE_MS)
  }, [queryClient])

  const handleMessage = useCallback(
    (msg: { type: string;[key: string]: unknown }) => {
      if (!isCommunityEvent(msg)) return
      const event = msg as CommunityWsEvent
      const communityStore = useCommunityStore.getState()
      const sub = communityStore.subscription
      const wsStore = useCommunityWsStore.getState()
      // A DM is a channel now — every message/typing/reaction event carries a
      // single `channelId`. The subscription still tracks two slots so the
      // handler can route a DM channel's events into the `dmMessages` cache vs
      // a regular channel's into `channelMessages` (`sub.dmConversationId`
      // holds the focused DM's channel id). An event is "focused" if its
      // channelId matches either slot.
      const matchesFocus = (e: { channelId?: string }): boolean => {
        if (!e.channelId) return false
        return e.channelId === sub.channelId || e.channelId === sub.dmConversationId
      }
      const context: CommunityWsHandlerContext = {
        queryClient,
        communityStore,
        wsStore,
        sub,
        viewerUserIdRef,
        matchesFocus,
        scheduleInboxInvalidate,
      }

      switch (event.type) {
        case "community:message.create":
          return handleMessageCreate(event, context)
        case "community:unread.bump":
          return handleUnreadBump(event, context)
        case "community:reaction.add":
        case "community:reaction.remove":
          return handleReactionEvent(event, context)
        case "community:pin.add":
        case "community:pin.remove":
          return handlePinEvent(event, context)
        case "community:typing.start":
          return handleTypingStart(event, context)
        case "community:typing.stop":
          return handleTypingStop(event, context)
        case "community:channel.child_create":
          return handleChildChannelCreate(event, context)
        case "community:channel.child_update":
          return handleChildChannelUpdate(event, context)
        case "community:server.update":
          return handleServerUpdate(event, context)
        case "community:server.delete":
          return handleServerDelete(event, context)
        case "community:channel.create":
        case "community:channel.update":
        case "community:channel.delete":
        case "community:channel.reorder":
          return handleChannelEvent(event, context)
        case "community:category.create":
        case "community:category.update":
        case "community:category.delete":
        case "community:category.reorder":
          return handleCategoryEvent(event, context)
        case "community:channel.member_add":
        case "community:channel.member_remove":
          return handleChannelMemberEvent(event, context)
        case "community:member.join":
          return handleMemberJoin(event, context)
        case "community:member.leave":
          return handleMemberLeave(event, context)
        case "community:member.update":
          return handleMemberUpdate(event, context)
        case "community:invite.create":
          return handleInviteCreate(event, context)
        case "community:friend.request":
        case "community:friend.accept":
        case "community:friend.reject":
        case "community:friend.remove":
        case "community:friend.block":
          return handleFriendEvent(event, context)
        case "community:message.updated":
          return handleMessageUpdated(event, context)
        case "community:message.edited":
          return handleMessageEdited(event, context)
        case "community:presence.update":
          return handlePresenceUpdate(event)
        case "community:status.update":
          return handleStatusUpdate(event)
        case "community:bot.audit_event":
          return handleBotAuditEvent(event)
        case "community:mention.create":
          return handleMentionCreate(event, context)
        case "community:machine.created":
          return handleMachineCreated(event, context)
        case "community:machine.status":
          return handleMachineStatus(event, context)
        case "community:machine.updated":
          return handleMachineUpdated(event, context)
        case "community:machine.removed":
          return handleMachineRemoved(event, context)
        default: {
          const unhandledEvent: never = event
          return unhandledEvent
        }
      }
    },
    [queryClient, scheduleInboxInvalidate],
  )

  const handleReconnect = useCallback(() => {
    reconcileCommunityWsReconnect(queryClient)
  }, [queryClient])
  const { send } = useUserWs(handleMessage, {
    onReconnect: handleReconnect,
    onDisconnect: useCommunityWsStore.getState().markAccessDisconnected,
    onAuthenticated: useCommunityWsStore.getState().markAccessConnected,
    requestDaemonStatusOnAuth: false,
  })

  // Publish the send binding so free helpers (`communityWsSendTyping`) can
  // dispatch without holding a hook reference. Single-instance assumption
  // matches the "mount at tree root" contract; if a second call site invoked
  // the hook, the last one would win. Cleared on unmount.
  useEffect(() => {
    // #15: warn if a second hook instance has mounted while another is still
    // active. Two live subscribers would each publish their own `send` into
    // this module slot — the second mount overwrites the first, and the
    // first's cleanup then clears the slot mid-flight (see the `activeSend
    // === send` check below). Whoever added the second mount site should
    // co-locate them under a single root-level `useCommunityWs()` call.
    if (activeSend !== null && activeSend !== send) {
      console.warn(
        "[useCommunityWs] Multiple instances detected — mount this hook once at the tree root.",
      )
    }
    activeSend = send
    return () => {
      if (activeSend === send) activeSend = null
    }
  }, [send])

  // Cleanup: flush the inbox debounce if the hook unmounts mid-window so the
  // parent surface doesn't leave a scheduled fetch dangling.
  useEffect(() => {
    return () => {
      if (inboxDebounce.current) {
        clearTimeout(inboxDebounce.current)
        inboxDebounce.current = null
      }
    }
  }, [])
}
