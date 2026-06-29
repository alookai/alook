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
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
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
  CommunityMentionCreate,
} from "@alook/shared"
import { isCommunityEvent, TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"

// ── Types ─────────────────────────────────────────────────────────────────────

export type Subscription = {
  channelId?: string
  dmConversationId?: string
}

export type CommunityWsCallbacks = {
  onMessage?: (event: CommunityMessageCreate) => void
  onReaction?: (event: CommunityReactionAdd | CommunityReactionRemove) => void
  onTyping?: (event: CommunityTypingStart | CommunityDmTyping) => void
  onPresence?: (event: CommunityPresenceUpdate) => void
  onChildChannel?: (event: CommunityChildChannelCreate | CommunityChildChannelUpdate) => void
  onMember?: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
  onChannel?: (event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => void
  onPin?: (event: CommunityPinAdd | CommunityPinRemove) => void
  onDm?: (event: CommunityDmNewMessage | CommunityDmTyping) => void
  onFriend?: (event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => void
  onServer?: (event: CommunityServerUpdate | CommunityServerDelete) => void
  onCategory?: (event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => void
  onMention?: (event: CommunityMentionCreate) => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

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

      // ── Child channels (threads + forum posts) ────────────────────────
      case "community:channel.child_create":
      case "community:channel.child_update":
        cbs.onChildChannel?.(event)
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

      // ── Mentions (always delivered) ──────────────────────────────────
      case "community:mention.create":
        cbs.onMention?.(event)
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
      if (now - lastSent < TYPING_INDICATOR_TIMEOUT_MS) return

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
 * Events with channelId/dmConversationId are filtered;
 * user-level events (friends, DMs, presence) bypass this check.
 */
function matchesSubscription(
  event: { channelId?: string; dmConversationId?: string },
  sub: Subscription
): boolean {
  if (!sub.channelId && !sub.dmConversationId) return false

  if (event.dmConversationId && sub.dmConversationId) return event.dmConversationId === sub.dmConversationId
  if (event.channelId && sub.channelId) return event.channelId === sub.channelId

  return false
}
