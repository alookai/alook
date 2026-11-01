import { communityKeys } from "@/lib/query-keys"
import type { CommunityWsProjectionTransaction } from "./projection-transaction"

export function invalidateChannelRefDirectory(
  projection: CommunityWsProjectionTransaction,
) {
  projection.invalidate("channel-ref-directory", {
    queryKey: communityKeys.channelRefDirectory(),
    exact: true,
  })
  invalidateChannelRefTargets(projection)
}

export function invalidateChannelRefTargets(projection: CommunityWsProjectionTransaction) {
  projection.fence("channel-ref-targets", { queryKey: communityKeys.channelRefTargets() })
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
