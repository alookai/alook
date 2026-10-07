

import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCommunityRuntime } from "@/stores/community/runtime"

import type {
  CommunityChannelMembershipChange,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

import { patchMemberWindows } from "@/hooks/community/use-server-members"
import {
  invalidateForumSidebarBaseExact,
  isKnownNonForumSidebarChannel,
} from "@/hooks/community/use-forum-sidebar-threads"
import { ApiError } from "@/lib/errors"

import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent, type ChannelMetadataResource } from "@/hooks/community/channel-metadata"
import { runCommunityWsProjectionTransaction } from "./projection-transaction"
import type { MembershipEventContext } from "@/hooks/community/community-ws/handler-context"
import { projectChannelScopeEviction } from "./channel-scope-projection"
import { evictScopeContent, evictServerChannelScopes } from "./scope-eviction"


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
import {
  getCanonicalCommunityChannels,
  purgeCommunityChannel,
} from "@/lib/community-db/sync"

type ChannelMemberEvent = Extract<
  CommunityWsEvent,
  { type: "community:channel.member_add" | "community:channel.member_remove" }
>

function retireChannelAccess(event: { serverId: string | null; channelId: string }, context: MembershipEventContext) {
  if (event.serverId !== null) {
    projectChannelScopeEviction(context.projection, context.queryClient, event.serverId, event.channelId)
  } else {
    getCommunityRuntime(context.queryClient).ws.actions.revokeChannelAccess(null, event.channelId)
    getAccountUnreadProjection(context.queryClient, context.viewerUserIdRef.current!).retireAccessScope({ kind: "channel", channelId: event.channelId })
    evictScopeContent(context.queryClient, null, event.channelId)
    const registry = getCommunityDbRegistry(context.queryClient)
    if (registry) purgeCommunityChannel(registry, event.channelId)
  }
}

function refreshChannelAccess(event: { serverId: string | null; channelId: string }, context: MembershipEventContext) {
  const { queryClient } = context
  const token = captureChannelMetadataToken(queryClient, event.channelId)
  const key = communityKeys.channelMeta(event.serverId, event.channelId)
  void (async () => {
    await queryClient.cancelQueries({ queryKey: key, exact: true })
    if (!isChannelMetadataTokenCurrent(token)) return
    try {
      await queryClient.query({ ...channelMetadataOptions(queryClient, event.serverId, event.channelId), staleTime: 0, retry: false, select: undefined })
      if (!isChannelMetadataTokenCurrent(token)) return
      const channel = getCanonicalCommunityChannels(queryClient).find((row) => row.id === event.channelId && row.serverId === event.serverId)
      if (channel?.archived) runCommunityWsProjectionTransaction(queryClient, (projection) => retireChannelAccess(event, { ...context, projection }))
      else if (channel) getAccountUnreadProjection(queryClient, context.viewerUserIdRef.current!).grantAccessScope({ kind: "channel", channelId: event.channelId })
    } catch (error) {
      if (!isChannelMetadataTokenCurrent(token)) return
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        runCommunityWsProjectionTransaction(queryClient, (projection) => retireChannelAccess(event, { ...context, projection }))
      }
    }
  })()
}

export function handleChannelMembershipChange(event: CommunityChannelMembershipChange, context: MembershipEventContext) {
  const { queryClient, projection, viewerUserIdRef } = context
  if (event.serverId) invalidateServerDetail(projection, event.serverId)
  invalidateChannelRefDirectory(projection)
  projection.fence("channel-roster", { queryKey: communityKeys.channelMembers(event.channelId, event.relation) })
  projection.invalidate("channel-addable-members", { queryKey: communityKeys.channelAddableMembers(event.channelId) })
  if (event.relation === "notify") projection.invalidate("thread-participants", { queryKey: communityKeys.threadParticipants(event.channelId) })
  if (event.userId !== viewerUserIdRef.current) return
  invalidateInbox(projection)
  invalidateServersList(projection)
  if (event.serverId && !isKnownNonForumSidebarChannel(queryClient, event.serverId, event.channelId)) {
    void invalidateForumSidebarBaseExact(queryClient, event.serverId).catch(() => undefined)
  }
  if (event.relation === "notify") {
    if (!event.present) getAccountUnreadProjection(queryClient, event.userId).retireNotificationScope({ kind: "channel", channelId: event.channelId })
    return
  }
  if (!event.present) retireChannelAccess(event, context)
  else getCommunityRuntime(queryClient).ws.actions.beginChannelMembershipChange(event.serverId, event.channelId)
  refreshChannelAccess(event, context)
}

export function handleChannelMemberEvent(event: ChannelMemberEvent, context: MembershipEventContext) {
  const { queryClient } = context
  const key = communityKeys.channelMeta(event.serverId, event.channelId)
  const proof = queryClient.getQueryData<ChannelMetadataResource>(key)?.verification
  const channel = getCanonicalCommunityChannels(queryClient).find((row) => row.id === event.channelId && row.serverId === event.serverId)
  const verified = !!proof && isChannelMetadataTokenCurrent(proof) && !channel?.pending && !channel?.archived
    && !getCommunityRuntime(queryClient).ws.actions.isChannelAccessRevoked(event.channelId, event.serverId)
  const relation = verified && channel?.type === "thread" ? "notify"
    : verified && (channel?.type === "text" || channel?.type === "forum") ? "access" : undefined
  if (relation) {
    handleChannelMembershipChange({ ...event, type: "community:channel.membership.change", relation, present: event.type === "community:channel.member_add" }, context)
    if (relation === "notify" && event.userId === context.viewerUserIdRef.current) {
      const token = captureChannelMetadataToken(queryClient, event.channelId)
      context.projection.fence("channel-metadata", { queryKey: key, exact: true }, () => isChannelMetadataTokenCurrent(token))
    }
    return
  }
  if (event.userId === context.viewerUserIdRef.current) {
    retireChannelAccess(event, context)
    refreshChannelAccess(event, context)
  } else invalidateChannelRoster(context.projection, event.channelId)
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
  const { queryClient, viewerUserIdRef, projection } = context
  patchMemberWindows(queryClient, event)
  // MEMBER_JOIN intentionally carries identity, not presence. Refresh the
  // affected server's authoritative presence seed so a newly rendered member
  // does not inherit the offline fallback until the next presence frame.
  invalidatePresence(projection, event.serverId)
  refreshServerReactionDetails(queryClient, event.serverId)
  if (event.member.userId === viewerUserIdRef.current) {
    const viewerId = viewerUserIdRef.current
    if (viewerId) {
      getCommunityRuntime(context.queryClient).ws.actions.grantServerAccess(event.serverId)
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
  patchMemberWindows(queryClient, event)
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
    getCommunityRuntime(context.queryClient).messageStream.actions.removeServer(event.serverId)
    queryClient.removeQueries({ queryKey: communityKeys.server(event.serverId) })
    const store = getCommunityRuntime(context.queryClient).ui.get()
    if (store.currentServerId === event.serverId) {
      getCommunityRuntime(context.queryClient).ui.actions.setCurrentChannelId(null)
      getCommunityRuntime(context.queryClient).ui.actions.setCurrentServerId(null)
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
  patchMemberWindows(queryClient, event)
  finishMemberEvent(event, context)
}
