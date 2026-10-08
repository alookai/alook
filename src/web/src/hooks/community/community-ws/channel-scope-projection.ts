
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
import type { CommunityWsProjectionTransaction } from "./projection-transaction"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityForumPost, publishCommunityDeletedForumPost, type CommunityFreshQueryProof } from "@/lib/community-db/sync"

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
  options?: { queries?: ReadonlySet<Query>; assertView?: () => void; proof?: CommunityFreshQueryProof },
) {
  let viewCurrent = true
  try { options?.assertView?.() } catch { viewCurrent = false }
  const wasCurrent = getCommunityRuntime(queryClient).ui.get().currentChannelId === unit.childChannelId
  const registry = getCommunityDbRegistry(queryClient)
  if (registry) {
    if (options?.proof) {
      if (!publishCommunityDeletedForumPost(queryClient, unit, options.proof, options)) return false
    } else purgeCommunityForumPost(registry, unit)
  }
  evictForumPostUnitQueryCaches(queryClient, unit, options?.queries)
  getCommunityRuntime(queryClient).messageStream.actions.dispatch({
    kind: "channel",
    id: unit.forumChannelId,
    serverId: unit.serverId,
  }, {
    type: "messageRemoved",
    messageId: unit.openerMessageId,
  })
  const store = getCommunityRuntime(queryClient).ui.get()
  if (wasCurrent && viewCurrent) {
    getCommunityRuntime(queryClient).ui.actions.setCurrentChannelId(unit.forumChannelId)
    clearLastChannel(unit.serverId)
    store.uiHandlers.replacePath?.(
      channelHref(unit.serverId, unit.forumChannelId),
    )
  }
  return true
}
