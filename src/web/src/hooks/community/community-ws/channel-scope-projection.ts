import type { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityStore } from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { clearLastChannel } from "@/lib/community/last-channel"
import { channelHref } from "@/lib/community/community-route"
import type { PageCache } from "./cache"
import { removeThreadFromCache } from "./cache"
import type { ForumFeedPage } from "@/hooks/community/use-forum-feed"
import { removeForumPostFromFeed } from "@/hooks/community/forum-feed-tag-transition"
import type { InfiniteData } from "@tanstack/react-query"
import {
  isKnownNonForumSidebarChannel,
  removeForumSidebarChildrenForParent,
  removeForumSidebarThreadExact,
  removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { CommunityWsProjectionTransaction } from "./projection-transaction"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { updateStructuralSnapshot } from "@/lib/community/structural-snapshot"
import { collectChannelScopeIds, evictScopeContent } from "./scope-eviction"

export function projectChannelScopeEviction(
  projection: CommunityWsProjectionTransaction,
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  const ids = collectChannelScopeIds(queryClient, serverId, channelId)
  const store = useCommunityWsStore.getState()
  for (const id of store.revokeChannelAccess(serverId, channelId)) ids.add(id)
  projection.project(() => {
    for (const id of ids) {
      store.revokeChannelAccess(serverId, id)
      getActiveAccountUnreadProjection(queryClient).retireAccessScope({ kind: "channel", channelId: id })
      evictChannelScopeQueryCaches(queryClient, serverId, id)
      evictScopeContent(queryClient, serverId, id)
    }
    updateStructuralSnapshot(queryClient, {
      type: "removeChannel",
      serverId,
      channelId,
    })
  })
}

function evictChannelScopeQueryCaches(
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  void queryClient.cancelQueries({ queryKey: ["community", "channel", channelId] })
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
  queryClient.removeQueries({ queryKey: communityKeys.channelMessages(channelId) })
  queryClient.removeQueries({ queryKey: communityKeys.pins(channelId) })
  queryClient.removeQueries({ queryKey: communityKeys.threads(channelId) })
}

export type ForumPostUnitIdentity = {
  serverId: string
  forumChannelId: string
  childChannelId: string
  openerMessageId: string
}

/** Query-only post-unit eviction, shared by optimistic HTTP and WS success. */
export function evictForumPostUnitQueryCaches(
  queryClient: QueryClient,
  unit: ForumPostUnitIdentity,
) {
  evictChannelScopeQueryCaches(queryClient, unit.serverId, unit.childChannelId)
  queryClient.setQueriesData<PageCache>(
    { queryKey: communityKeys.channelMessages(unit.forumChannelId) },
    (cache) => removeThreadFromCache(cache, unit.childChannelId, unit.openerMessageId),
  )
  queryClient.setQueriesData<InfiniteData<ForumFeedPage>>(
    { queryKey: communityKeys.forumFeeds(unit.forumChannelId) },
    (cache) => removeForumPostFromFeed(
      cache,
      unit.childChannelId,
      unit.openerMessageId,
    ),
  )
  queryClient.removeQueries({
    queryKey: communityKeys.forumOpenerHint(unit.serverId, unit.openerMessageId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: communityKeys.message(unit.openerMessageId),
    exact: true,
  })
}

/** Canonical WS projection: evict one forum post and eject an active child. */
export function projectForumPostUnitEviction(
  projection: CommunityWsProjectionTransaction,
  queryClient: QueryClient,
  unit: ForumPostUnitIdentity,
) {
  projection.project(() => {
    applyForumPostUnitClientEffects(queryClient, unit)
  })
}

/**
 * Idempotent success-side effects shared by the HTTP initiator and WS peers.
 * The initiator calls this after 204 so correctness never depends on receiving
 * its own fan-out frame; an eventual self frame simply converges again.
 */
export function applyForumPostUnitClientEffects(
  queryClient: QueryClient,
  unit: ForumPostUnitIdentity,
) {
  const wasCurrent = useCommunityStore.getState().currentChannelId === unit.childChannelId
  useCommunityWsStore.getState().revokeChannelAccess(unit.serverId, unit.childChannelId)
  getActiveAccountUnreadProjection(queryClient).retireAccessScope({
    kind: "channel",
    channelId: unit.childChannelId,
  })
  evictForumPostUnitQueryCaches(queryClient, unit)
  evictScopeContent(queryClient, unit.serverId, unit.childChannelId)
  useMessageStreamStore.getState().removeScope({
    kind: "channel",
    id: unit.childChannelId,
    serverId: unit.serverId,
  })
  useMessageStreamStore.getState().dispatch({
    kind: "channel",
    id: unit.forumChannelId,
    serverId: unit.serverId,
  }, {
    type: "messageRemoved",
    messageId: unit.openerMessageId,
  })
  updateStructuralSnapshot(queryClient, {
    type: "removeChildHint",
    serverId: unit.serverId,
    channelId: unit.childChannelId,
  })
  const store = useCommunityStore.getState()
  if (wasCurrent) {
    store.setCurrentChannelMeta(null)
    store.setCurrentChannelId(unit.forumChannelId)
    clearLastChannel(unit.serverId)
    store.uiHandlers.replacePath?.(
      channelHref(unit.serverId, unit.forumChannelId),
    )
  }
}
