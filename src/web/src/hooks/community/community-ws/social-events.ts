import type {
  CommunityFriendAccept,
  CommunityFriendBlock,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendRequest,
  CommunityMentionCreate,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { patchChannelUnread } from "@/hooks/community/server-detail-cache"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"
import {
  hasProjectedForumSidebarThread,
  patchForumSidebarUnreadExact,
  recordForumSidebarChildUnread,
  setForumSidebarParentUnreadBase,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { SocialEventContext } from "@/hooks/community/community-ws/handler-context"
import {
  invalidateFriends,
  invalidateInbox,
  invalidateServersList,
} from "./invalidation-projections"

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
  { queryClient, viewerUserIdRef, sub }: SocialEventContext,
) {
  const viewerId = viewerUserIdRef.current
  // `railChannelId` is the always-locatable fallback. A participating
  // forum child now has its own nested row, so prefer that row when it
  // is loaded; ordinary/expired children continue to light the parent.
  const railChannelId = event.railChannelId ?? event.channelId
  const targetServerId =
    event.serverId ?? useCommunityStore.getState().currentServerId
  const hasChildSidebarRow = !!targetServerId && event.channelId !== railChannelId &&
    hasProjectedForumSidebarThread(
      queryClient,
      targetServerId,
      event.channelId,
      sub.channelId,
    )
  const sidebarChannelId = hasChildSidebarRow ? event.channelId : railChannelId
  // Suppress the dot for the channel the viewer is actually looking at
  // (its unread clears on read anyway) — compare against the ROW being
  // lit, so a thread bump whose parent is open still suppresses.
  if (event.userId === viewerId && sidebarChannelId !== sub.channelId) {
    // Channel-tree dot: patch the RIGHT server's detail. `serverId`
    // (inbox-dot-ws-driven) lets an other-server message light its dot
    // — previously only the open server was patched, so cross-server
    // bumps never lit. Absent serverId (DM bump / older frame) → fall
    // back to the currently-open server (backward-compatible).
    if (hasChildSidebarRow && targetServerId) {
      patchForumSidebarUnreadExact(queryClient, targetServerId, event.channelId, true)
      recordForumSidebarChildUnread(
        queryClient,
        targetServerId!,
        railChannelId,
        event.channelId,
        true,
      )
    } else if (targetServerId) {
      if (event.channelId !== railChannelId) {
        recordForumSidebarChildUnread(
          queryClient,
          targetServerId,
          railChannelId,
          event.channelId,
        )
      } else {
        const hasChildFallback = setForumSidebarParentUnreadBase(
          queryClient,
          targetServerId,
          railChannelId,
          true,
        )
        if (!hasChildFallback) {
          queryClient.setQueryData<ServerDetail | undefined>(
            communityKeys.server(targetServerId),
            (cache) => patchChannelUnread(cache, railChannelId, true),
          )
        }
      }
    }
    // Rail mention badge: the rail row carries only a `mentions` count
    // (no separate unread dot — plain unread lives on the tree dot
    // above). So bump the rail badge ONLY for a mention, on the right
    // server row. Needs `serverId`; a DM/older frame without it can't
    // locate a rail row, so skip (the tree dot / inbox still reflect it).
    if (event.isMention && event.serverId) {
      const bumpServerId = event.serverId
      queryClient.setQueryData<ServersResponse | undefined>(
        communityKeys.servers(),
        (prev) =>
          prev
            ? {
              ...prev,
              servers: prev.servers.map((s) =>
                s.id === bumpServerId
                  ? { ...s, mentions: s.mentions + 1 }
                  : s,
              ),
            }
            : prev,
      )
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
  _event: FriendEvent,
  { projection }: SocialEventContext,
) {
  invalidateFriends(projection)
}

export function handleMentionCreate(
  _event: CommunityMentionCreate,
  { projection }: SocialEventContext,
) {
  invalidateInbox(projection)
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
