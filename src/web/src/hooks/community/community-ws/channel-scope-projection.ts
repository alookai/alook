
import { getCommunityRuntime } from "@/stores/community/runtime"
import type { Query,QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"


import { clearLastChannel } from "@/lib/community/last-channel"
import { channelHref } from "@/lib/community/community-route"
import type { PageCache } from "./cache"
import { removeThreadFromCache } from "./cache"
import type { ForumFeedPage } from "@/hooks/community/use-forum-feed"
import { removeForumPostFromFeed } from "@/hooks/community/forum-feed-window"
import type { InfiniteData } from "@tanstack/react-query"
import {
isKnownNonForumSidebarChannel,
removeForumSidebarChildrenForParent,
removeForumSidebarThreadExact,
removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { CommunityWsProjectionTransaction } from "./projection-transaction"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityChannel,purgeCommunityForumPost } from "@/lib/community-db/sync"
import { collectChannelScopeIds,evictScopeContent } from "./scope-eviction"

export function projectChannelScopeEviction(
  projection: CommunityWsProjectionTransaction,
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  const ids = collectChannelScopeIds(queryClient, serverId, channelId)
  for (const id of getCommunityRuntime(queryClient).ws.actions.revokeChannelAccess(serverId, channelId)) ids.add(id)
  projection.project(() => {
    for (const id of ids) {
      getCommunityRuntime(queryClient).ws.actions.revokeChannelAccess(serverId, id)
      getActiveAccountUnreadProjection(queryClient).retireAccessScope({ kind: "channel", channelId: id })
      evictChannelScopeQueryCaches(queryClient, serverId, id)
      evictScopeContent(queryClient, serverId, id)
    }
    const registry = getCommunityDbRegistry(queryClient)
    if (registry) purgeCommunityChannel(registry, channelId)
  })
}

function evictChannelScopeQueryCaches(
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
  queries?: ReadonlySet<Query>,
) {
  const allowed = (query: Query) => !queries || queries.has(query)
  void queryClient.cancelQueries({ queryKey: ["community", "channel", channelId], predicate: allowed })
  const nonForum = isKnownNonForumSidebarChannel(queryClient, serverId, channelId)
  const sidebar = queryClient.getQueryCache().find({ queryKey: communityKeys.forumSidebarThreads(serverId), exact: true })
  if (!nonForum && (!queries || sidebar && queries.has(sidebar))) {
    removeForumSidebarUnreadChild(queryClient, serverId, channelId)
    removeForumSidebarChildrenForParent(queryClient, serverId, channelId)
    removeForumSidebarThreadExact(queryClient, serverId, channelId)
  } else {
    queryClient.removeQueries({
      queryKey: communityKeys.channelMeta(serverId, channelId),
      exact: true,
      predicate: allowed,
    })
  }
  queryClient.removeQueries({ queryKey: communityKeys.channelMessages(channelId), predicate: allowed })
  queryClient.removeQueries({ queryKey: communityKeys.pins(channelId), predicate: allowed })
  queryClient.removeQueries({ queryKey: communityKeys.threads(channelId), predicate: allowed })
}

export type ForumPostUnitIdentity = {
  serverId: string
  forumChannelId: string
  childChannelId: string
  openerMessageId: string
}

/** Query-only post-unit eviction, shared by optimistic HTTP and WS success. */
function evictForumPostUnitQueryCaches(
  queryClient: QueryClient,
  unit: ForumPostUnitIdentity,
  queries?: ReadonlySet<Query>,
) {
  const allowed = (query: Query) => !queries || queries.has(query)
  evictChannelScopeQueryCaches(queryClient, unit.serverId, unit.childChannelId, queries)
  queryClient.setQueriesData<PageCache>(
    { queryKey: communityKeys.channelMessages(unit.forumChannelId), predicate: allowed },
    (cache) => removeThreadFromCache(cache, unit.childChannelId, unit.openerMessageId),
  )
  queryClient.setQueriesData<InfiniteData<ForumFeedPage>>(
    { queryKey: communityKeys.forumFeeds(unit.forumChannelId), predicate: allowed },
    (cache) => removeForumPostFromFeed(
      cache,
      unit.childChannelId,
      unit.openerMessageId,
    ),
  )
  queryClient.removeQueries({
    queryKey: communityKeys.message(unit.openerMessageId),
    exact: true,
    predicate: allowed,
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
  options?: { queries?: ReadonlySet<Query>; assertView?: () => void; canonical?: boolean },
) {
  let viewCurrent = true
  try { options?.assertView?.() } catch { viewCurrent = false }
  const wasCurrent = getCommunityRuntime(queryClient).ui.get().currentChannelId === unit.childChannelId
  getCommunityRuntime(queryClient).ws.actions.revokeChannelAccess(unit.serverId, unit.childChannelId)
  getActiveAccountUnreadProjection(queryClient).retireAccessScope({
    kind: "channel",
    channelId: unit.childChannelId,
  })
  evictForumPostUnitQueryCaches(queryClient, unit, options?.queries)
  evictScopeContent(queryClient, unit.serverId, unit.childChannelId, options)
  getCommunityRuntime(queryClient).messageStream.actions.removeScope({
    kind: "channel",
    id: unit.childChannelId,
    serverId: unit.serverId,
  })
  getCommunityRuntime(queryClient).messageStream.actions.dispatch({
    kind: "channel",
    id: unit.forumChannelId,
    serverId: unit.serverId,
  }, {
    type: "messageRemoved",
    messageId: unit.openerMessageId,
  })
  const registry = getCommunityDbRegistry(queryClient)
  if (registry && options?.canonical !== false) purgeCommunityForumPost(registry, unit)
  const store = getCommunityRuntime(queryClient).ui.get()
  if (wasCurrent && viewCurrent) {
    getCommunityRuntime(queryClient).ui.actions.setCurrentChannelId(unit.forumChannelId)
    clearLastChannel(unit.serverId)
    store.uiHandlers.replacePath?.(
      channelHref(unit.serverId, unit.forumChannelId),
    )
  }
}
