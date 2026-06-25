"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useUserWs } from "@/lib/use-user-ws"
import type {
  CommunityWsEvent,
  CommunityMessageCreate,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityTypingStart,
  CommunityPresenceUpdate,
  CommunityThreadCreate,
  CommunityThreadUpdate,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityChannelCreate,
  CommunityChannelUpdate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityDmNewMessage,
  CommunityDmTyping,
  CommunityFriendRequest,
  CommunityFriendAccept,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendBlock,
  CommunityServerUpdate,
  CommunityServerDelete,
  CommunityCategoryCreate,
  CommunityCategoryUpdate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
} from "@/lib/community/ws-events"
import { isCommunityEvent } from "@/lib/community/ws-events"

// ── Types ─────────────────────────────────────────────────────────────────────

export type Subscription = {
  channelId?: string
  threadId?: string
  dmConversationId?: string
}

export type CommunityWsCallbacks = {
  onMessage?: (event: CommunityMessageCreate) => void
  onReaction?: (event: CommunityReactionAdd | CommunityReactionRemove) => void
  onTyping?: (event: CommunityTypingStart | CommunityDmTyping) => void
  onPresence?: (event: CommunityPresenceUpdate) => void
  onThread?: (event: CommunityThreadCreate | CommunityThreadUpdate) => void
  onMember?: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
  onChannel?: (event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => void
  onPin?: (event: CommunityPinAdd | CommunityPinRemove) => void
  onDm?: (event: CommunityDmNewMessage | CommunityDmTyping) => void
  onFriend?: (event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => void
  onServer?: (event: CommunityServerUpdate | CommunityServerDelete) => void
  onCategory?: (event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Typing broadcast debounce (client-side) — 8 seconds per the plan */
const TYPING_DEBOUNCE_MS = 8_000

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCommunityWs(callbacks: CommunityWsCallbacks) {
  const [subscription, setSubscription] = useState<Subscription>({})
  const subscriptionRef = useRef<Subscription>({})
  const callbacksRef = useRef(callbacks)
  const seenMessageIds = useRef<Set<string>>(new Set())
  const lastTypingSent = useRef<Map<string, number>>(new Map())

  // Keep refs up to date
  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])

  useEffect(() => {
    subscriptionRef.current = subscription
  }, [subscription])

  // Handle incoming WS messages
  const handleMessage = useCallback((msg: { type: string; [key: string]: unknown }) => {
    if (!isCommunityEvent(msg)) return
    const event = msg as CommunityWsEvent
    const sub = subscriptionRef.current
    const cbs = callbacksRef.current

    switch (event.type) {
      // ── Messages ──────────────────────────────────────────────────────
      case "community:message.create": {
        // Dedup by message ID
        if (seenMessageIds.current.has(event.message.id)) return
        seenMessageIds.current.add(event.message.id)
        // Cap the set size to prevent unbounded growth
        if (seenMessageIds.current.size > 500) {
          seenMessageIds.current = new Set(
            [...seenMessageIds.current].slice(-400)
          )
        }
        // Only deliver if matches focused subscription
        if (matchesSubscription(event, sub)) {
          cbs.onMessage?.(event)
        }
        break
      }

      // ── Reactions ─────────────────────────────────────────────────────
      case "community:reaction.add":
      case "community:reaction.remove":
        if (matchesSubscription(event, sub)) {
          cbs.onReaction?.(event)
        }
        break

      // ── Pins ──────────────────────────────────────────────────────────
      case "community:pin.add":
      case "community:pin.remove":
        if (matchesSubscription(event, sub)) {
          cbs.onPin?.(event)
        }
        break

      // ── Typing ────────────────────────────────────────────────────────
      case "community:typing.start":
        if (matchesSubscription(event, sub)) {
          cbs.onTyping?.(event)
        }
        break

      // ── Threads ───────────────────────────────────────────────────────
      case "community:thread.create":
      case "community:thread.update":
        cbs.onThread?.(event)
        break

      // ── Server ────────────────────────────────────────────────────────
      case "community:server.update":
      case "community:server.delete":
        cbs.onServer?.(event)
        break

      // ── Channels ──────────────────────────────────────────────────────
      case "community:channel.create":
      case "community:channel.update":
      case "community:channel.delete":
      case "community:channel.reorder":
        cbs.onChannel?.(event)
        break

      // ── Categories ────────────────────────────────────────────────────
      case "community:category.create":
      case "community:category.update":
      case "community:category.delete":
      case "community:category.reorder":
        cbs.onCategory?.(event)
        break

      // ── Members ───────────────────────────────────────────────────────
      case "community:member.join":
      case "community:member.leave":
      case "community:member.update":
        cbs.onMember?.(event)
        break

      // ── Friends (always delivered regardless of subscription) ──────────
      case "community:friend.request":
      case "community:friend.accept":
      case "community:friend.reject":
      case "community:friend.remove":
      case "community:friend.block":
        cbs.onFriend?.(event)
        break

      // ── DMs (always delivered regardless of subscription) ─────────────
      case "community:dm.new_message":
      case "community:dm.typing":
        cbs.onDm?.(event)
        // Also fire typing callback for DM typing
        if (event.type === "community:dm.typing") {
          cbs.onTyping?.(event)
        }
        break

      // ── Presence (always delivered) ───────────────────────────────────
      case "community:presence.update":
        cbs.onPresence?.(event)
        break
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, [])

  const { send } = useUserWs(handleMessage as any)

  // ── Public methods ──────────────────────────────────────────────────────────

  /** Subscribe to a channel/thread/DM (client-local state only) */
  const subscribe = useCallback((target: Subscription) => {
    setSubscription(target)
  }, [])

  /** Clear subscription (e.g., navigating away) */
  const unsubscribe = useCallback(() => {
    setSubscription({})
  }, [])

  /**
   * Send a typing indicator. Client-side debounced at 8s per channelId/dmConversationId.
   * The DO also applies server-side dedup.
   */
  const sendTyping = useCallback(
    (target: { channelId?: string; dmConversationId?: string; threadId?: string }) => {
      const key = target.channelId || target.dmConversationId || target.threadId || ""
      if (!key) return

      const now = Date.now()
      const lastSent = lastTypingSent.current.get(key) || 0
      if (now - lastSent < TYPING_DEBOUNCE_MS) return

      lastTypingSent.current.set(key, now)
      send({ type: "community:typing.start", ...target })
    },
    [send]
  )

  return {
    subscribe,
    unsubscribe,
    sendTyping,
    subscription,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determines if an event matches the current focused subscription.
 * Events with channelId/threadId/dmConversationId are filtered;
 * user-level events (friends, DMs, presence) bypass this check.
 */
function matchesSubscription(
  event: { channelId?: string; dmConversationId?: string; threadId?: string },
  sub: Subscription
): boolean {
  // If subscription is empty, nothing matches (user hasn't focused a conversation)
  if (!sub.channelId && !sub.threadId && !sub.dmConversationId) return false

  // Match by the most specific scope
  if (event.threadId && sub.threadId) return event.threadId === sub.threadId
  if (event.dmConversationId && sub.dmConversationId) return event.dmConversationId === sub.dmConversationId
  if (event.channelId && sub.channelId) return event.channelId === sub.channelId

  return false
}
