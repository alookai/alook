import {
  isDesktop,
  isMobile,
  type CommunityFriendAccept,
  type CommunityFriendBlock,
  type CommunityFriendReject,
  type CommunityFriendRemove,
  type CommunityFriendRequest,
  type CommunityMentionCreate,
  type CommunityInboxChanged,
  type CommunityReadStateAdvanced,
  type CommunityWsEvent,
} from "@alook/shared"
import type { SocialEventContext } from "@/hooks/community/community-ws/handler-context"
import {
  invalidateFriends,
} from "./invalidation-projections"
import {
  projectReadStateEnvelope,
  reconcileAccountReadState,
} from "./read-state-reconciliation"
import { removeDmReactionDetails } from "./reaction-details-invalidation"
import { reconcileNotificationSettings } from "@/hooks/community/use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import {
  clearDesktopSystemNotificationsForViewer,
  dismissDesktopSystemNotificationConversation,
  resolveDesktopSystemNotificationCandidate,
  showDesktopSystemNotification,
} from "@/lib/community/desktop-system-notification"
import {
  clearMobileSystemNotificationsForViewer,
  dismissMobileSystemNotificationConversation,
} from "@/lib/community/mobile-system-notification"
import { scheduleAccountAttentionReconcile } from "@/hooks/community/use-account-attention"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { applyCommunityDmBlockAccess } from "@/lib/community-db/sync"

export function handleReadStateAdvanced(
  event: CommunityReadStateAdvanced,
  context: SocialEventContext,
) {
  applyReadStateEnvelope(event, context)
}

function dismissAdvancedNativeConversations(
  viewerId: string,
  context: SocialEventContext,
  previousReadSeq: ReadonlyMap<string, number>,
  nextReadStates: ReadonlyArray<{ channelId: string; lastReadSeq: number }>,
) {
  if (context.viewerUserIdRef.current !== viewerId) return
  const registry = getCommunityDbRegistry(context.queryClient)
  for (const row of nextReadStates) {
    if (row.lastReadSeq <= (previousReadSeq.get(row.channelId) ?? 0)) continue
    if (isDesktop()) {
      const channel = registry?.collections.channels.get(row.channelId)
      if (!channel) continue
      const target = channel.type === "dm"
        ? { kind: "dm" as const, channelId: row.channelId }
        : channel.serverId
        ? { kind: "server" as const, serverId: channel.serverId, channelId: row.channelId }
        : null
      if (target) {
        void dismissDesktopSystemNotificationConversation(viewerId, target).catch(() => undefined)
      }
    } else if (isMobile()) {
      void dismissMobileSystemNotificationConversation(viewerId, row.channelId).catch(() => undefined)
    }
  }
}

function applyReadStateEnvelope(
  event: CommunityReadStateAdvanced | CommunityInboxChanged,
  context: SocialEventContext,
) {
  const viewerId = context.viewerUserIdRef.current
  const shouldDismissNative = Boolean(viewerId && (isDesktop() || isMobile()))
  const previousReadSeq = new Map<string, number>()
  if (shouldDismissNative) {
    const registry = getCommunityDbRegistry(context.queryClient)
    if (registry) {
      for (const row of registry.collections.readStates.values()) {
        previousReadSeq.set(row.channelId, row.lastReadSeq)
      }
    }
  }
  const outcome = projectReadStateEnvelope(context.queryClient, event)
  if (outcome === "gap") {
    void reconcileAccountReadState(context.queryClient, {
      targetRevision: event.revision,
    }).then((snapshot) => {
      if (!shouldDismissNative || !viewerId || context.viewerUserIdRef.current !== viewerId) return
      if (event.type === "community:inbox.changed" && event.reason === "read_all") {
        if (isDesktop()) void clearDesktopSystemNotificationsForViewer(viewerId).catch(() => undefined)
        else if (isMobile()) void clearMobileSystemNotificationsForViewer(viewerId).catch(() => undefined)
        return
      }
      dismissAdvancedNativeConversations(viewerId, context, previousReadSeq, snapshot.readStates)
    }).catch(() => undefined)
  }
}

export function handleInboxChanged(
  event: CommunityInboxChanged,
  context: SocialEventContext,
) {
  if (event.reason === "notification_policy") {
    void reconcileNotificationSettings(context.queryClient).then(() => scheduleAccountAttentionReconcile(context.queryClient)).catch(() => undefined)
  }
  applyReadStateEnvelope(event, context)
}

type CommunityUnreadBump = Extract<
  CommunityWsEvent,
  { type: "community:unread.bump" }
>

// Mute-gated on the server (only recipients whose effective level
// delivers get this), so the sidebar unread dot flips ONLY here — a
// muted channel's `message.create` no longer lights it. Skip the
// currently-subscribed channel (dot suppressed there anyway) and never
// for the viewer's own sends (the server excludes the author, but guard
// defensively).
export function handleUnreadBump(
  event: CommunityUnreadBump,
  context: SocialEventContext,
) {
  const {
    queryClient,
    viewerUserIdRef,
    unreadBumpEvidence,
  } = context
  const viewerId = viewerUserIdRef.current
  if (event.userId === viewerId && viewerId) {
    const evidence = unreadBumpEvidence?.get(event)
    scheduleAccountAttentionReconcile(queryClient, { channelId: event.channelId, messageId: evidence?.messageId })
    if (evidence && isDesktop()) {
      void resolveDesktopSystemNotificationCandidate(
        evidence.messageEvent,
        event,
        viewerId,
        queryClient,
      ).then((candidate) => {
        if (candidate && viewerUserIdRef.current === viewerId) {
          return showDesktopSystemNotification(candidate)
        }
      }).catch(() => undefined)
    }
  }
}

type FriendEvent =
  | CommunityFriendRequest
  | CommunityFriendAccept
  | CommunityFriendReject
  | CommunityFriendRemove
  | CommunityFriendBlock

export function handleFriendEvent(
  event: FriendEvent,
  { projection, queryClient }: SocialEventContext,
) {
  scheduleAccountAttentionReconcile(queryClient)
  if (event.type === "community:friend.request") {
    invalidateFriends(projection)
  } else {
    projection.fence("friends", {
      queryKey: communityKeys.friends(),
      exact: true,
    })
  }
  if (event.type === "community:friend.block") {
    const registry = getCommunityDbRegistry(queryClient)
    if (registry) applyCommunityDmBlockAccess(registry, event.userId, true)
    removeDmReactionDetails(queryClient)
  }
}

export function handleMentionCreate(
  event: CommunityMentionCreate,
  {
    queryClient,
    viewerUserIdRef,
  }: SocialEventContext,
) {
  const viewerId = viewerUserIdRef.current
  if (!viewerId || event.userId !== viewerId) return
  scheduleAccountAttentionReconcile(queryClient, { channelId: event.channelId, messageId: event.messageId })
}
