import { communityKeys } from "@/lib/query-keys"
import type { CommunityWsProjectionTransaction } from "./projection-transaction"
import { channelRefTargetAffected, type ChannelRefTarget } from "@/lib/community/channel-ref"

type ReferenceScope = { serverId?: string | null; channelId?: string }

export function invalidateChannelRefDirectory(
  projection: CommunityWsProjectionTransaction,
  scope?: ReferenceScope,
) {
  projection.invalidate("channel-ref-directory", {
    queryKey: communityKeys.channelRefDirectory(),
    exact: true,
  })
  invalidateChannelRefTargets(projection, scope)
}

export function invalidateChannelRefTargets(projection: CommunityWsProjectionTransaction, scope?: ReferenceScope) {
  projection.fence(`channel-ref-targets:${scope?.channelId ?? scope?.serverId ?? "all"}`, {
    queryKey: communityKeys.channelRefTargets(), predicate: query => channelRefTargetAffected((query.state.data as { target?: ChannelRefTarget } | undefined)?.target, scope),
  })
}

export function invalidateServerDetail(
  projection: CommunityWsProjectionTransaction,
  serverId: string,
) {
  projection.invalidate("server-detail", {
    queryKey: communityKeys.server(serverId),
    exact: true,
  })
}

export function invalidateServersList(
  projection: CommunityWsProjectionTransaction,
) {
  projection.invalidate("servers-list", {
    queryKey: communityKeys.servers(),
    exact: true,
  })
}

export function invalidateChannelMembers(
  projection: CommunityWsProjectionTransaction,
  channelId: string,
) {
  projection.invalidate("channel-members", {
    queryKey: communityKeys.channelMembers(channelId),
  })
}

export function invalidateThreads(
  projection: CommunityWsProjectionTransaction,
  channelId: string,
) {
  projection.invalidate("threads", {
    queryKey: communityKeys.threads(channelId),
  })
}

export function invalidateChannelMessages(
  projection: CommunityWsProjectionTransaction,
  channelId: string,
) {
  projection.invalidate("channel-messages", {
    queryKey: communityKeys.channelMessages(channelId),
  })
}

export function invalidatePins(
  projection: CommunityWsProjectionTransaction,
  channelId: string,
) {
  projection.invalidate("pins", {
    queryKey: communityKeys.pins(channelId),
  })
}

export function invalidateFriends(
  projection: CommunityWsProjectionTransaction,
) {
  projection.invalidate("friends", { queryKey: communityKeys.friends() })
}

export function invalidateInbox(
  projection: CommunityWsProjectionTransaction,
) {
  projection.invalidate("attention", { queryKey: communityKeys.accountAttention(), exact: true })
}

export function invalidatePresence(
  projection: CommunityWsProjectionTransaction,
  serverId: string,
) {
  projection.invalidate("presence", {
    queryKey: communityKeys.presence(serverId),
    exact: true,
    refetchType: "active",
  })
}

export function invalidateInvitableFriends(
  projection: CommunityWsProjectionTransaction,
  serverId: string,
) {
  projection.invalidate("invitable-friends", {
    queryKey: communityKeys.invitableFriends(serverId),
  })
}

export function invalidateInvites(
  projection: CommunityWsProjectionTransaction,
  serverId: string,
) {
  projection.invalidate("invites", {
    queryKey: communityKeys.invites(serverId),
    exact: true,
  })
}

export function invalidateForumSidebar(projection: CommunityWsProjectionTransaction, serverId: string) {
  projection.fence("forum-sidebar-base", { queryKey: communityKeys.forumSidebarThreads(serverId), exact: true })
}
