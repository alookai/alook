import type { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail } from "@/hooks/community/use-servers"
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
    queryClient.setQueryData<ServerDetail | undefined>(
      communityKeys.server(serverId),
      (server) => {
        if (!server) return server
        let changed = false
        const categories = server.categories.map((category) => {
          const channels = category.channels.filter((channel) => channel.id !== channelId)
          if (channels.length === category.channels.length) return category
          changed = true
          return { ...category, channels }
        })
        return changed ? { ...server, categories } : server
      },
    )
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
