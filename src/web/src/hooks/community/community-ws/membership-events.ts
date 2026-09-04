import type { InfiniteData } from "@tanstack/react-query"
import type {
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCommunityStore } from "@/stores/community"
import {
  patchCacheJoin,
  patchCacheLeave,
  patchCacheUpdate,
  dispatchMemberOverlayEvent,
  type MembersEnvelope,
} from "@/hooks/community/use-server-members"
import {
  grantForumSidebarChild,
  isKnownNonForumSidebarChannel,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { MembershipEventContext } from "@/hooks/community/community-ws/handler-context"
import { projectChannelScopeEviction } from "./channel-scope-projection"
import { avatarInitial } from "@/lib/community/avatar"
import {
  invalidateChannelRefDirectory,
  invalidateChannelRoster,
  invalidateInvitableFriends,
  invalidatePresence,
  invalidateServerDetail,
  invalidateServersList,
} from "./invalidation-projections"
import {
  refreshServerReactionDetails,
  removeServerReactionDetails,
} from "./reaction-details-invalidation"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"

type ChannelMemberEvent = Extract<
  CommunityWsEvent,
  { type: "community:channel.member_add" | "community:channel.member_remove" }
>

export function handleChannelMemberEvent(
  event: ChannelMemberEvent,
  { queryClient, viewerUserIdRef, projection }: MembershipEventContext,
) {
  // Re-run the viewer-scoped server tree so the sidebar gains/loses the
  // private channel. On REMOVE for the viewer, evict that channel's
  // scoped caches so no private content lingers locally (mirrors the
  // channel.delete eviction above).
  if (
    event.type === "community:channel.member_remove" &&
    event.userId === viewerUserIdRef.current
  ) {
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      getAccountUnreadProjection(queryClient, viewerId).retireAccessScope({
        kind: "channel",
        channelId: event.channelId,
      })
    }
    projectChannelScopeEviction(
      projection,
      queryClient,
      event.serverId,
      event.channelId,
    )
  } else if (
    event.type === "community:channel.member_add" &&
    event.userId === viewerUserIdRef.current
  ) {
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      getAccountUnreadProjection(queryClient, viewerId).grantAccessScope({
        kind: "channel",
        channelId: event.channelId,
      })
    }
    if (!isKnownNonForumSidebarChannel(queryClient, event.serverId, event.channelId)) {
      void grantForumSidebarChild(queryClient, event.serverId, event.channelId)
        .catch(() => undefined)
    }
  }
  invalidateServerDetail(projection, event.serverId)
  invalidateChannelRefDirectory(projection)
  // Refetch the channel roster so an open private-channel Members drawer
  // (and the manage-members dialog) reflect the add/remove live.
  // The addable-members candidate pool is the complement of the roster —
  // a peer's add/remove changes it too, so an open add dialog doesn't
  // offer a just-added member (whose Add would 400) or hide a removed one.
  // A forum thread's "Add participant" emits this same MEMBER_ADD event —
  // its Members panel is the participant set, so refetch it too. No-op
  // for a plain channel (participants query disabled there).
  invalidateChannelRoster(projection, event.channelId)
}

function finishMemberEvent(
  event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate,
  { projection }: MembershipEventContext,
) {
  // Membership just changed → the invite dialog's "friends who aren't
  // in this server" list is stale. Cheap invalidation because the
  // query is disabled unless the dialog is actually open.
  if (event.type !== "community:member.update") {
    invalidateInvitableFriends(projection, event.serverId)
  }
}

export function handleMemberJoin(
  event: CommunityMemberJoin,
  context: MembershipEventContext,
) {
  const { queryClient, viewerUserIdRef, projection, wsStore } = context
  wsStore.patchProfiles(wsStore.beginProfileSnapshot(), [{
    id: event.member.userId,
    identityAbout: {
      name: event.member.name,
      discriminator: event.member.discriminator,
    },
    avatar: {
      avatar: event.member.avatar ?? avatarInitial(event.member.name),
      avatarVersion: event.member.avatarVersion,
    },
  }])
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheJoin(cache, event),
  )
  dispatchMemberOverlayEvent({ type: "refresh", serverId: event.serverId })
  // MEMBER_JOIN intentionally carries identity, not presence. Refresh the
  // affected server's authoritative presence seed so a newly rendered member
  // does not inherit the offline fallback until the next presence frame.
  invalidatePresence(projection, event.serverId)
  refreshServerReactionDetails(queryClient, event.serverId)
  if (event.member.userId === viewerUserIdRef.current) {
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      getAccountUnreadProjection(queryClient, viewerId).grantAccessScope({
        kind: "server",
        serverId: event.serverId,
      })
    }
    invalidateChannelRefDirectory(projection)
    invalidateServersList(projection)
    invalidateServerDetail(projection, event.serverId)
  }
  finishMemberEvent(event, context)
}

export function handleMemberLeave(
  event: CommunityMemberLeave,
  context: MembershipEventContext,
) {
  const { queryClient, viewerUserIdRef, projection } = context
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheLeave(cache, event),
  )
  dispatchMemberOverlayEvent({
    type: "leave",
    serverId: event.serverId,
    userId: event.userId,
  })
  // If the leaver is the viewer (kick from another tab / owner
  // cascade), the viewer's server rail is stale — invalidate it
  // so the layout's eject effect can detect the drop and route
  // the user away from the now-forbidden URL.
  if (event.userId === viewerUserIdRef.current) {
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      getAccountUnreadProjection(queryClient, viewerId).retireAccessScope({
        kind: "server",
        serverId: event.serverId,
      })
    }
    removeServerReactionDetails(queryClient, event.serverId)
    invalidateChannelRefDirectory(projection)
    useMessageStreamStore.getState().removeServer(event.serverId)
    queryClient.removeQueries({ queryKey: communityKeys.server(event.serverId) })
    const store = useCommunityStore.getState()
    if (store.currentServerId === event.serverId) {
      store.setCurrentChannelMeta(null)
      store.setCurrentChannelId(null)
      store.setCurrentServerId(null)
    }
    // Rail LIST only (the layout's eject effect reads it to route the
    // kicked viewer away). `exact` so a kick doesn't cascade-refetch
    // every server's nested detail subtree.
    invalidateServersList(projection)
  } else {
    refreshServerReactionDetails(queryClient, event.serverId)
  }
  finishMemberEvent(event, context)
}

export function handleMemberUpdate(
  event: CommunityMemberUpdate,
  context: MembershipEventContext,
) {
  const { queryClient } = context
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheUpdate(cache, event),
  )
  dispatchMemberOverlayEvent({
    type: "update",
    serverId: event.serverId,
    event,
  })
  finishMemberEvent(event, context)
}
