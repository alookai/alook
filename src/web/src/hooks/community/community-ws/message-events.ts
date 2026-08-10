import type {
  CommunityMessageCreate,
  CommunityMessageUpdated,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { projectCommunityMessageCreate } from "@/lib/community/message-wire"
import type { CanonicalMessage } from "@/lib/community/message-stream"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  getForumSidebarBase,
  hasForumSidebarThread,
  isForumSidebarParent,
  invalidateForumSidebarBaseExact,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { reconcileForumOpenerTitle } from "@/hooks/community/forum-opener-title-reconciliation"
import {
  applyReactionToCache,
  applyReactionToMessage,
  findCachedMessage,
  patchApprovalInCache,
  patchMessageContentInCache,
  type PageCache,
} from "@/hooks/community/community-ws/cache"
import { clearTypingIndicator, typingScopeKey } from "@/hooks/community/community-ws/typing"
import type { MessageEventContext } from "@/hooks/community/community-ws/handler-context"

type CommunityMessageEdited = Extract<
  CommunityWsEvent,
  { type: "community:message.edited" }
>

export function handleMessageCreate(
  event: CommunityMessageCreate,
  {
    queryClient,
    communityStore,
    wsStore,
    sub,
    viewerUserIdRef,
    scheduleInboxInvalidate,
  }: MessageEventContext,
) {
  const projected = projectCommunityMessageCreate(event.message)
  if (event.channelId === sub.channelId) {
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      useMessageStreamStore.getState().dispatch(
        { kind: "channel", id: event.channelId, serverId },
        { type: "wsMessage", message: projected },
      )
    }
  }
  if (event.channelId === sub.dmConversationId) {
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: event.channelId },
      { type: "wsMessage", message: projected },
    )
  }
  if (wsStore.hasSeenMessage(event.message.id)) return
  wsStore.markSeenMessage(event.message.id)
  // Sending a message is an implicit typing.stop for its author —
  // clear once we know this is a fresh message. Clearing before dedup
  // would also clear on WS-reconnect replays of stale messages,
  // briefly wiping a still-active heartbeat pill. Derive the scope
  // from whether this channelId is the focused DM channel (`dm:`) or a
  // regular channel (`ch:`) so the pill clears in the right bucket.
  clearTypingIndicator(typingScopeKey(event, sub), event.message.authorId)

  // Participation, not unread state, is the sidebar truth. A child
  // message reaches every notify member even when muted; use its
  // explicit server/parent metadata to re-rank a loaded row without a
  // GET, or refetch when the active post is currently absent/expired.
  if (
    event.serverId &&
    event.parentChannelId &&
    isForumSidebarParent(queryClient, event.serverId, event.parentChannelId)
  ) {
    const canonical = hasForumSidebarThread(
      getForumSidebarBase(queryClient, event.serverId),
      event.channelId,
    )
    patchForumSidebarActivityExact(
      queryClient,
      event.serverId,
      event.channelId,
      event.parentChannelId,
      event.message.createdAt,
    )
    if (!canonical) {
      void invalidateForumSidebarBaseExact(queryClient, event.serverId)
    }
  }

  // 1) A child channel enrolls its sender and mentioned users in its
  //    member set server-side, so refresh an open child roster live.
  if (
    event.channelId === sub.channelId &&
    communityStore.currentChannelId === event.channelId &&
    communityStore.currentChannelMeta?.parentChannelId
  ) {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.channelMembers(event.channelId),
    })
  }

  // 2) Every message.create — regardless of focus — schedules a
  //    debounced inbox invalidation. Skip messages authored by the
  //    viewer since they never affect their own unreads.
  const viewerId = viewerUserIdRef.current
  if (event.message.authorId !== viewerId) {
    scheduleInboxInvalidate()
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

type ReactionEvent = CommunityReactionAdd | CommunityReactionRemove

export function handleReactionEvent(
  event: ReactionEvent,
  { queryClient, viewerUserIdRef, sub }: MessageEventContext,
) {
  const viewerId = viewerUserIdRef.current
  // A reaction event carries only `channelId` with no channel-vs-DM
  // discriminator. A regular channel's cache lives under
  // `channelMessages(id)`, a DM channel's under `dmMessages(id)` — patch
  // both keys; the one that doesn't exist receives `undefined` and the
  // updater returns it, a harmless no-op.
  queryClient.setQueriesData<PageCache>(
    { queryKey: communityKeys.channelMessages(event.channelId) },
    (c) => applyReactionToCache(c, event, viewerId),
  )
  queryClient.setQueryData<PageCache>(
    communityKeys.dmMessages(event.channelId),
    (c) => applyReactionToCache(c, event, viewerId),
  )
  if (event.channelId === sub.channelId) {
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      const scope = { kind: "channel" as const, id: event.channelId, serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.id === event.messageId)
      if (fallback) {
        const cached = findCachedMessage(
          queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.channelId)),
          event.messageId,
        )
        const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
        useMessageStreamStore.getState().dispatch(scope, {
          type: "liveRefreshed",
          message: applyReactionToMessage(source, event, viewerId) as CanonicalMessage,
        })
      }
    }
  }
  if (event.channelId === sub.dmConversationId) {
    const scope = { kind: "dm" as const, id: event.channelId }
    const fallback = [...getMessageOverlay(scope).liveById.values()]
      .find((message) => message.id === event.messageId)
    if (fallback) {
      const cached = findCachedMessage(
        queryClient.getQueryData<PageCache>(communityKeys.dmMessages(event.channelId)),
        event.messageId,
      )
      const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
      useMessageStreamStore.getState().dispatch(scope, {
        type: "liveRefreshed",
        message: applyReactionToMessage(source, event, viewerId) as CanonicalMessage,
      })
    }
  }
}

export function handlePinEvent(
  event: CommunityPinAdd | CommunityPinRemove,
  { queryClient }: MessageEventContext,
) {
  void queryClient.invalidateQueries({ queryKey: communityKeys.pins(event.channelId) })
}

export function handleMessageUpdated(
  event: CommunityMessageUpdated,
  { queryClient, sub }: MessageEventContext,
) {
  // Folded from the old `dm.message_updated` — keyed by `channelId` (the
  // DM's channel id). Patch the card's approval payload in the focused
  // DM cache so it re-renders in its new state without a refetch.
  if (event.channelId === sub.dmConversationId || event.channelId === sub.channelId) {
    queryClient.setQueryData<PageCache>(
      communityKeys.dmMessages(event.channelId),
      (c) => patchApprovalInCache(c, event.messageId, event.approval),
    )
    queryClient.setQueryData<PageCache>(
      communityKeys.channelMessages(event.channelId),
      (c) => patchApprovalInCache(c, event.messageId, event.approval),
    )
  }
  const overlayScopes = event.channelId === sub.dmConversationId
    ? [{ kind: "dm" as const, id: event.channelId }]
    : event.channelId === sub.channelId
      ? (() => {
        const serverId = useCommunityStore.getState().currentServerId
        return serverId
          ? [{ kind: "channel" as const, id: event.channelId, serverId }]
          : []
      })()
      : []
  for (const scope of overlayScopes) {
    const fallback = [...getMessageOverlay(scope).liveById.values()]
      .find((message) => message.id === event.messageId)
    if (!fallback) continue
    const key = scope.kind === "dm"
      ? communityKeys.dmMessages(event.channelId)
      : communityKeys.channelMessages(event.channelId)
    const cached = findCachedMessage(
      queryClient.getQueryData<PageCache>(key),
      event.messageId,
    )
    const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
    useMessageStreamStore.getState().dispatch(scope, {
      type: "liveRefreshed",
      message: { ...source, approval: event.approval },
    })
  }
  // When a card resolves (accepted/denied/superseded), the friend graph
  // changed — invalidate friends + pending so the owner's lists reflect
  // it. This is the owner's only signal in the J2 tail (Alice's accept
  // dead-letters FRIEND_ACCEPT to the bot).
  if (event.approval.status !== "pending" || event.approval.waitingOn !== "you") {
    void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
  }
}

export function handleMessageEdited(
  event: CommunityMessageEdited,
  { queryClient }: MessageEventContext,
) {
  if (event.parentChannelId) {
    void reconcileForumOpenerTitle(queryClient, {
      serverId: event.serverId,
      forumChannelId: event.parentChannelId,
      childChannelId: event.channelId,
      openerMessageId: event.messageId,
      content: event.content,
    })
    return
  }
  queryClient.setQueryData<{ content: string }>(
    communityKeys.message(event.messageId),
    (message) => message ? { ...message, content: event.content } : message,
  )
  queryClient.setQueriesData<PageCache>(
    { queryKey: communityKeys.channelMessages(event.channelId) },
    (cache) => patchMessageContentInCache(cache, event.messageId, event.content),
  )
  queryClient.setQueryData<PageCache>(
    communityKeys.dmMessages(event.channelId),
    (cache) => patchMessageContentInCache(cache, event.messageId, event.content),
  )
  const streamStore = useMessageStreamStore.getState()
  for (const entry of streamStore.entries.values()) {
    if (entry.scope.id !== event.channelId) continue
    streamStore.dispatch(entry.scope, {
      type: "messageEdited",
      messageId: event.messageId,
      content: event.content,
    })
  }
}
