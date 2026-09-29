import type {
  CommunityMessageCreate,
  CommunityMessageUpdated,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityWsEvent,
} from "@alook/shared"
import { projectCommunityMessageCreate } from "@/lib/community/message-wire"
import { useCommunityStore } from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  hasForumSidebarOwnershipEvidence,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { reconcileForumOpenerTitle } from "@/hooks/community/forum-opener-title-reconciliation"
import { clearTypingIndicator, typingScopeKey } from "@/hooks/community/community-ws/typing"
import type { MessageEventContext } from "@/hooks/community/community-ws/handler-context"
import { scheduleFocusedMessageGapRepair } from "@/hooks/community/community-ws/reconnect-messages"
import { armInboxReadReservationCandidate } from "@/hooks/community/inbox-read-reservation"
import {
  approvalProfilePatches,
  messageProfilePatches,
  writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import {
  projectApprovalCopies,
  projectEditedCopies,
  projectReactionCopies,
} from "@/hooks/community/community-ws/message-projections"
import {
  invalidateChannelMembers,
  invalidateFriends,
  invalidatePins,
} from "@/hooks/community/community-ws/invalidation-projections"
import { fetchChannelMetadata } from "@/hooks/community/channel-metadata"
import {
  captureCommunityLiveSnapshotToken,
  reconcileCanonicalChannelMetadata,
} from "@/lib/community-db/sync"

type CommunityMessageEdited = Extract<
  CommunityWsEvent,
  { type: "community:message.edited" }
>

function warmLiveForumChildOwner(
  queryClient: MessageEventContext["queryClient"],
  event: CommunityMessageCreate,
) {
  if (
    !event.serverId
    || !event.parentChannelId
    || !isForumSidebarParent(queryClient, event.serverId, event.parentChannelId)
    || hasForumSidebarOwnershipEvidence(queryClient, event.serverId, event.channelId)
  ) return
  const token = captureCommunityLiveSnapshotToken(queryClient)
  void fetchChannelMetadata(event.serverId, event.channelId)
    .then(async (metadata) => {
      await reconcileCanonicalChannelMetadata(queryClient, {
        metadata,
        proof: { token, signal: undefined },
      })
    })
    .catch(() => undefined)
}

export function handleMessageCreate(
  event: CommunityMessageCreate,
  {
    queryClient,
    communityStore,
    wsStore,
    sub,
    viewerUserIdRef,
    matchesFocus,
    projection,
  }: MessageEventContext,
) {
  warmLiveForumChildOwner(queryClient, event)
  const viewerId = viewerUserIdRef.current
  const hasSeenMessage = wsStore.hasSeenMessage(event.message.id)
  const isForeignFocused = event.message.authorId !== viewerId
    && matchesFocus(event)
  const projected = projectCommunityMessageCreate(event.message)
  writeCommunityProfilePatches(messageProfilePatches([projected]), undefined, { event: true })
  if (isForeignFocused && !hasSeenMessage) {
    armInboxReadReservationCandidate(queryClient, {
      channelId: event.channelId,
      lastMessageAt: event.message.createdAt,
      seq: event.message.seq,
    })
  }
  if (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) {
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      void scheduleFocusedMessageGapRepair(
        queryClient,
        { kind: "channel", scopeId: event.channelId, serverId },
        event.message.seq,
      )
      useMessageStreamStore.getState().dispatch(
        { kind: "channel", id: event.channelId, serverId },
        { type: "wsMessage", message: projected },
      )
    }
  }
  if (event.channelId === sub.dmConversationId) {
    void scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "dm", scopeId: event.channelId },
      event.message.seq,
    )
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: event.channelId },
      { type: "wsMessage", message: projected },
    )
  }
  if (hasSeenMessage) return
  wsStore.markSeenMessage(event.message.id)
  // Sending a message is an implicit typing.stop for its author —
  // clear once we know this is a fresh message. Clearing before dedup
  // would also clear on WS-reconnect replays of stale messages,
  // briefly wiping a still-active heartbeat pill. Derive the scope
  // from whether this channelId is the focused DM channel (`dm:`) or a
  // regular channel (`ch:`) so the pill clears in the right bucket.
  clearTypingIndicator(typingScopeKey(event, sub), event.message.authorId)


  if (
    event.serverId &&
    event.parentChannelId &&
    isForumSidebarParent(queryClient, event.serverId, event.parentChannelId)
  ) {
    patchForumSidebarActivityExact(
      queryClient,
      event.serverId,
      event.channelId,
      event.parentChannelId,
      event.message.createdAt,
    )
  }

  // 1) A child channel enrolls its sender and mentioned users in its
  //    member set server-side, so refresh an open child roster live.
  if (
    (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) &&
    (event.parentChannelId || (communityStore.currentChannelId === event.channelId && communityStore.currentChannelMeta?.parentChannelId))
  ) {
    invalidateChannelMembers(projection, event.channelId)
  }

  // 3) Live channel-sidebar unread dot is NO LONGER flipped here.
  //    Unread is per-recipient and mute-gated on the server now, so it
  //    rides the dedicated `community:unread.bump` event (below) — a
  //    muted (`nothing`/unmentioned-`mentions`) channel must NOT light
  //    an unread dot even though its `message.create` still arrives
  //    (mute ≠ blindness: content syncs, the badge does not).

  // Note: no auto-mark-read here. See #3 — the
  // IntersectionObserver in `useChannelWatermark` advances the
  // read pointer when a message actually becomes visible in the
  // viewport. If the user is scrolled up reading history, their
  // pointer must stay put; the WS handler cannot know whether the
  // incoming message is on screen.

}

export function handleReactionEvent(
  event: CommunityReactionAdd | CommunityReactionRemove,
  context: MessageEventContext,
) {
  projectReactionCopies(event, context)
}

export function handlePinEvent(
  event: CommunityPinAdd | CommunityPinRemove,
  { projection }: MessageEventContext,
) {
  invalidatePins(projection, event.channelId)
}

export function handleMessageUpdated(
  event: CommunityMessageUpdated,
  context: MessageEventContext,
) {
  writeCommunityProfilePatches(approvalProfilePatches(event.approval), undefined, { event: true })
  projectApprovalCopies(event, context)
  // When a card resolves (accepted/denied/superseded), the friend graph
  // changed — invalidate friends + pending so the owner's lists reflect
  // it. This is the owner's only signal in the J2 tail (Alice's accept
  // dead-letters FRIEND_ACCEPT to the bot).
  if (event.approval.status !== "pending" || event.approval.waitingOn !== "you") {
    invalidateFriends(context.projection)
  }
}

export function handleMessageEdited(
  event: CommunityMessageEdited,
  context: MessageEventContext,
) {
  const { queryClient } = context
  if (event.parentChannelId) {
    if (!event.serverId) return
    void reconcileForumOpenerTitle(queryClient, {
      serverId: event.serverId,
      forumChannelId: event.parentChannelId,
      childChannelId: event.channelId,
      openerMessageId: event.messageId,
      content: event.content,
    })
    return
  }
  projectEditedCopies(event, context)
}
