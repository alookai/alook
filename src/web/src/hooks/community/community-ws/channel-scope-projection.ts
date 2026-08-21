import type { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  isKnownNonForumSidebarChannel,
  removeForumSidebarChildrenForParent,
  removeForumSidebarThreadExact,
  removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { CommunityWsProjectionTransaction } from "./projection-transaction"

export function projectChannelScopeEviction(
  projection: CommunityWsProjectionTransaction,
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  projection.project(() => {
    const nonForum = isKnownNonForumSidebarChannel(queryClient, serverId, channelId)
    if (!nonForum) {
      removeForumSidebarUnreadChild(queryClient, serverId, channelId)
      removeForumSidebarChildrenForParent(queryClient, serverId, channelId)
      removeForumSidebarThreadExact(queryClient, serverId, channelId)
    } else {
      queryClient.removeQueries({
        queryKey: communityKeys.channelMeta(serverId, channelId),
        exact: true,
      })
    }
    if (useCommunityStore.getState().currentChannelId === channelId) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
    }
    useMessageStreamStore.getState().removeScope({
      kind: "channel",
      id: channelId,
      serverId,
    })
    queryClient.removeQueries({ queryKey: communityKeys.channelMessages(channelId) })
    queryClient.removeQueries({ queryKey: communityKeys.pins(channelId) })
    queryClient.removeQueries({ queryKey: communityKeys.threads(channelId) })
  })
}
