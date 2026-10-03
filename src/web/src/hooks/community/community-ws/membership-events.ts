

import { getCommunityRuntime } from "@/stores/community/runtime"

import type {
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

import { patchMemberWindows } from "@/hooks/community/use-server-members"
import {
  removeForumSidebarProjectionExact,
  invalidateForumSidebarBaseExact,
  isKnownNonForumSidebarChannel,
} from "@/hooks/community/use-forum-sidebar-threads"
import { ApiError } from "@/lib/errors"

import { fetchChannelMetadata, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import { runCommunityWsProjectionTransaction } from "./projection-transaction"
import type { MembershipEventContext } from "@/hooks/community/community-ws/handler-context"
import { projectChannelScopeEviction } from "./channel-scope-projection"
import { evictServerChannelScopes } from "./scope-eviction"


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
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
  publishCommunityChannelMetadata,
  setCanonicalCommunityChannelMember,
} from "@/lib/community-db/sync"

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
  const viewerChange = event.userId === viewerUserIdRef.current
  if (viewerChange) {
    invalidateInbox(projection)
    invalidateServersList(projection)
    void invalidateForumSidebarBaseExact(queryClient, event.serverId).catch(() => undefined)
  }
  const store = getCommunityRuntime(context.queryClient).ws.get()
  if (viewerChange) getCommunityRuntime(context.queryClient).ws.actions.beginChannelMembershipChange(event.serverId, event.channelId)
  const token = captureChannelMetadataToken(queryClient, event.channelId)
  const originalLiveToken = captureCommunityLiveSnapshotToken(queryClient)
  const key = communityKeys.channelMeta(event.serverId, event.channelId)
  const cached = queryClient.getQueryData<{ type: string; verifiedEpoch: number }>(key)
  const apply = (type: string, activeProjection = projection) => {
    setCanonicalCommunityChannelMember(queryClient, event.channelId, event.userId, type === "thread" ? "notify" : "access", event.type === "community:channel.member_add", { event: true })
    if (!viewerChange) return
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
      getCommunityRuntime(context.queryClient).ws.actions.rememberChannelAccess(event.serverId, event.channelId)
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
        queryFn: async ({ signal }) => {
          assertCommunityLiveSnapshotTokenCurrent(queryClient, originalLiveToken, signal)
          const metadata = await fetchChannelMetadata(queryClient, event.serverId, event.channelId, signal, token)
          publishCommunityChannelMetadata(queryClient, {
            metadata,
            proof: { token: originalLiveToken, signal },
          })
          return { id: metadata.id, serverId: metadata.serverId, type: metadata.type, verifiedEpoch: metadata.verifiedEpoch }
        },
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
