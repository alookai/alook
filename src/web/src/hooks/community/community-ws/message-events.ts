import { invalidateBotSurfaces } from "@/hooks/community/use-bots"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCommunityRuntime, readCurrentCommunityChannelMeta } from "@/stores/community/runtime"
import type {
  CommunityMessageCreate,
  CommunityMessageUpdated,
  CommunityPinAdd,
  CommunityPinRemove,
} from "@alook/shared"

import {
  hasForumSidebarOwnershipEvidence,
  getForumSidebarBase,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { clearTypingIndicator, typingScopeKey } from "@/lib/community/typing"
import type { CommunityWsHandlerContext } from "@/hooks/community/community-ws/handler-context"
import { scheduleFocusedMessageGapRepair } from "@/lib/community/message-reconcile"
import { armInboxReadReservationCandidate } from "@/hooks/community/inbox-read-reservation"
import {
  approvalProfilePatches,
  writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"

import {
  invalidateChannelMembers,
  invalidateForumSidebar,
  invalidateFriends,
  invalidatePins,
} from "@/hooks/community/community-ws/invalidation-projections"
import { channelMetadataOptions } from "@/lib/community/channel-metadata"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"

function warmLiveForumChildOwner(
  queryClient: CommunityWsHandlerContext["queryClient"],
  event: CommunityMessageCreate,
) {
  if (
    !event.serverId
    || !event.parentChannelId
    || !isForumSidebarParent(queryClient, event.serverId, event.parentChannelId)
    || hasForumSidebarOwnershipEvidence(queryClient, event.serverId, event.channelId)
  ) return
  void queryClient.query({ ...channelMetadataOptions(queryClient, event.serverId, event.channelId), select: undefined })
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
    contract,
  }: CommunityWsHandlerContext,
) {
  warmLiveForumChildOwner(queryClient, event)
  const viewerId = viewerUserIdRef.current
  const hasSeenMessage = wsStore.actions.hasSeenMessage(event.message.id)
  const isForeignFocused = event.message.authorId !== viewerId
    && matchesFocus(event)
  const projected = projectCommunityWsEventToDb(queryClient, event, contract)
  if (!projected) return
  if (isForeignFocused && !hasSeenMessage) {
    armInboxReadReservationCandidate(queryClient, {
      channelId: event.channelId,
      lastMessageAt: event.message.createdAt,
      seq: event.message.seq,
    })
  }
  if (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) {
    const serverId = getCommunityRuntime(queryClient).ui.get().currentServerId
    if (serverId) {
      void scheduleFocusedMessageGapRepair(
        queryClient,
        { kind: "channel", scopeId: event.channelId, serverId },
        event.message.seq,
      )
      getCommunityRuntime(queryClient).messageStream.actions.dispatch(
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
    getCommunityRuntime(queryClient).messageStream.actions.dispatch(
      { kind: "dm", id: event.channelId },
      { type: "wsMessage", message: projected },
    )
  }
  // Replayed messages must not clear current typing; only the first delivery does.
  if (hasSeenMessage) return
  wsStore.actions.markSeenMessage(event.message.id)

  clearTypingIndicator(queryClient, typingScopeKey(event, sub), event.message.authorId)

  if (
    event.serverId &&
    event.parentChannelId &&
    isForumSidebarParent(queryClient, event.serverId, event.parentChannelId)
  ) {
    if (!getForumSidebarBase(queryClient, event.serverId).threads.some(thread => thread.id === event.channelId)) {
      invalidateForumSidebar(projection, event.serverId)
    }
    patchForumSidebarActivityExact(
      queryClient,
      event.serverId,
      event.channelId,
      event.parentChannelId,
      event.message.createdAt,
    )
  }

  if (
    (event.channelId === sub.channelId || event.channelId === sub.secondaryChannelId) &&
    (event.parentChannelId || (communityStore.get().currentChannelId === event.channelId && readCurrentCommunityChannelMeta(queryClient)?.parentChannelId))
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

export function handlePinEvent(
  event: CommunityPinAdd | CommunityPinRemove,
  { projection }: CommunityWsHandlerContext,
) {
  invalidatePins(projection, event.channelId)
}

export function handleMessageUpdated(
  event: CommunityMessageUpdated,
  context: CommunityWsHandlerContext,
) {
  writeCommunityProfilePatches(approvalProfilePatches(event.approval), getCommunityDbRegistry(context.queryClient), { event: true, resourceSeed: true })
  if (event.botCreation?.status === "approved") invalidateBotSurfaces(context.queryClient)

  if (event.approval && (event.approval.status !== "pending" || event.approval.waitingOn !== "you")) {
    invalidateFriends(context.projection)
  }
}
