import type {
  CommunityFriendAccept,
  CommunityFriendBlock,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendRequest,
  CommunityMentionCreate,
  CommunityInboxChanged,
  CommunityReadStateAdvanced,
  CommunityWsEvent,
} from "@alook/shared"
import type { SocialEventContext } from "@/hooks/community/community-ws/handler-context"
import {
  invalidateFriends,
  invalidateServersList,
} from "./invalidation-projections"
import {
  projectReadStateEnvelope,
  reconcileAccountReadState,
} from "./read-state-reconciliation"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { removeDmReactionDetails } from "./reaction-details-invalidation"

export function handleReadStateAdvanced(
  event: CommunityReadStateAdvanced,
  context: SocialEventContext,
) {
  applyReadStateEnvelope(event, context)
}

function applyReadStateEnvelope(
  event: CommunityReadStateAdvanced | CommunityInboxChanged,
  context: SocialEventContext,
) {
  const outcome = projectReadStateEnvelope(context.queryClient, event)
  if (outcome === "gap") {
    context.scheduleInboxInvalidate({ inbox: true, dms: true })
    void reconcileAccountReadState(context.queryClient, {
      surfaceMode: "non-inbox",
      targetRevision: event.revision,
    }).catch(() => undefined)
  }
}

export function handleInboxChanged(
  event: CommunityInboxChanged,
  context: SocialEventContext,
) {
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
    scheduleInboxInvalidate,
  } = context
  const viewerId = viewerUserIdRef.current
  if (event.userId === viewerId && viewerId) {
    const evidence = unreadBumpEvidence?.get(event)
    getAccountUnreadProjection(queryClient, viewerId).recordArrival({
      channelId: event.channelId,
      railChannelId: event.railChannelId,
      serverId: event.serverId,
      isMention: event.isMention,
      messageId: evidence?.messageId,
      seq: evidence?.seq,
    })
    // Use the existing coalesced owner. This is also the sole authority
    // refresh for legacy/orphan bumps; the ledger itself performs no I/O.
    scheduleInboxInvalidate({ inbox: true, dms: !event.serverId })
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
  invalidateFriends(projection)
  if (event.type === "community:friend.block") removeDmReactionDetails(queryClient)
}

export function handleMentionCreate(
  event: CommunityMentionCreate,
  {
    projection,
    scheduleInboxInvalidate,
    queryClient,
    viewerUserIdRef,
    messageEvidenceByChannel,
  }: SocialEventContext,
) {
  const viewerId = viewerUserIdRef.current
  if (viewerId && event.userId === viewerId && event.channelId) {
    const candidate = messageEvidenceByChannel?.get(event.channelId)
    const evidence = candidate?.messageId === event.messageId ? candidate : undefined
    getAccountUnreadProjection(queryClient, viewerId).recordMentionArrival({
      channelId: event.channelId,
      messageId: event.messageId,
      seq: evidence?.seq,
      isMention: true,
    })
  }
  scheduleInboxInvalidate({ inbox: true, dms: false })
  // The server rail badge counts unread mentions per server; refresh
  // it on every new mention. `exact: true` is essential: the mention
  // count lives in the `servers()` LIST query, but members/presence/
  // invites/server(id) are all nested UNDER `servers()` in
  // the key hierarchy — a non-exact invalidate prefix-matches and
  // force-refetches that whole subtree (and invalidate overrides the
  // staleTime: Infinity those carry). With an active bot in the server,
  // every mention.create would otherwise storm-refetch all of them.
  invalidateServersList(projection)
}
