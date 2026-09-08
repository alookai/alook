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
  removeForumSidebarProjectionExact,
  invalidateForumSidebarBaseExact,
  isKnownNonForumSidebarChannel,
} from "@/hooks/community/use-forum-sidebar-threads"
import { ApiError } from "@/lib/errors"
import { useCommunityWsStore } from "@/stores/community/ws"
import { fetchChannelMetadata, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import { runCommunityWsProjectionTransaction } from "./projection-transaction"
import type { MembershipEventContext } from "@/hooks/community/community-ws/handler-context"
import { projectChannelScopeEviction } from "./channel-scope-projection"
import { evictServerChannelScopes } from "./scope-eviction"
import { avatarInitial } from "@/lib/community/avatar"
import {
  invalidateChannelRefDirectory,
  invalidateInbox,
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
  context: MembershipEventContext,
) {
  const { queryClient, viewerUserIdRef, projection } = context
  invalidateServerDetail(projection, event.serverId)
  invalidateChannelRefDirectory(projection)
  invalidateChannelRoster(projection, event.channelId)
  if (event.userId !== viewerUserIdRef.current) return
  invalidateInbox(projection)
  invalidateServersList(projection)
  void invalidateForumSidebarBaseExact(queryClient, event.serverId).catch(() => undefined)
  const store = useCommunityWsStore.getState()
  store.beginChannelMembershipChange(event.serverId, event.channelId)
  const token = captureChannelMetadataToken(event.channelId)
  const key = communityKeys.channelMeta(event.serverId, event.channelId)
  const cached = queryClient.getQueryData<{ type: string; verifiedEpoch: number }>(key)
  const apply = (type: string, activeProjection = projection) => {
    if (type === "thread") {
      if (event.type === "community:channel.member_remove") {
        getAccountUnreadProjection(queryClient, event.userId).retireNotificationScope({
          kind: "channel", channelId: event.channelId,
        })
        removeForumSidebarProjectionExact(queryClient, event.serverId, event.channelId)
      }
      void invalidateForumSidebarBaseExact(queryClient, event.serverId).catch(() => undefined)
      invalidateInbox(activeProjection)
      invalidateServersList(activeProjection)
      return
    }
    if (event.type === "community:channel.member_remove") {
      getAccountUnreadProjection(queryClient, event.userId).retireAccessScope({
        kind: "channel", channelId: event.channelId,
      })
      projectChannelScopeEviction(activeProjection, queryClient, event.serverId, event.channelId)
    } else {
      useCommunityWsStore.getState().rememberChannelAccess(event.serverId, event.channelId)
      getAccountUnreadProjection(queryClient, event.userId).grantAccessScope({
        kind: "channel", channelId: event.channelId,
      })
    }
  }
  if (cached?.verifiedEpoch === store.accessEpoch) {
    apply(cached.type)
    return
  }
  if (isKnownNonForumSidebarChannel(queryClient, event.serverId, event.channelId)) {
    apply("text")
    return
  }
  void (async () => {
    await queryClient.cancelQueries({ queryKey: key, exact: true })
    if (!isChannelMetadataTokenCurrent(token)) return
    try {
      const meta = await queryClient.fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => fetchChannelMetadata(event.serverId, event.channelId, signal),
        staleTime: 0,
      })
      if (!isChannelMetadataTokenCurrent(token)) return
      runCommunityWsProjectionTransaction(queryClient, (current) => apply(meta.type, current))
    } catch (error) {
      if (!isChannelMetadataTokenCurrent(token)) return
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        runCommunityWsProjectionTransaction(queryClient, (current) => {
          projectChannelScopeEviction(current, queryClient, event.serverId, event.channelId)
        })
      }
    }
  })()
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
      useCommunityWsStore.getState().grantServerAccess(event.serverId)
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
    evictServerChannelScopes(queryClient, event.serverId)
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
