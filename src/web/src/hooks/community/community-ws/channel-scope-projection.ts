import type { QueryClient, Query } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { useCommunityWsStore } from "@/stores/community/ws"
import { clearTypingIndicator } from "./typing"
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
  })
}

function collectChannelScopeIds(queryClient: QueryClient, serverId: string, channelId?: string) {
  const ids = new Set<string>(channelId ? [channelId] : [])
  const store = useCommunityStore.getState()
  const current = store.currentChannelMeta
  if (store.currentServerId === serverId && store.currentChannelId
    && (!channelId || current?.parentChannelId === channelId)) ids.add(store.currentChannelId)
  for (const [id, scope] of useCommunityWsStore.getState().channelAccessScopes) {
    if (scope.serverId === serverId && (!channelId || scope.parentChannelId === channelId)) ids.add(id)
  }
  for (const [, meta] of queryClient.getQueriesData<{ id: string; parentChannelId?: string }>(
    { queryKey: communityKeys.channelMetaRoot(serverId) },
  )) {
    if (meta && (!channelId || meta.parentChannelId === channelId)) ids.add(meta.id)
  }
  for (const { scope } of useMessageStreamStore.getState().entries.values()) {
    if (!channelId && scope.kind === "channel" && scope.serverId === serverId) ids.add(scope.id)
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== "object") return
    const row = value as Record<string, unknown>
    if (!channelId || row.parentChannelId === channelId) {
      if (typeof row.childChannelId === "string") ids.add(row.childChannelId)
      if (typeof row.id === "string" && (row.type === "thread" || row.type === "text" || row.type === "forum")) ids.add(row.id)
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") visit(child)
  }
  for (const [, data] of queryClient.getQueriesData({ queryKey: communityKeys.server(serverId) })) visit(data)
  if (channelId) for (const [, data] of queryClient.getQueriesData({ queryKey: communityKeys.threads(channelId) })) visit(data)
  return ids
}

function scopeQuery(query: Query, serverId: string, channelId: string) {
  const key = query.queryKey
  if (key[0] !== "community") return false
  if (key[1] === "channel" && key[2] === channelId) return true
  if (key[1] === "message-context" && key[2] === "channel" && key[3] === channelId) return true
  if (key[1] === "servers" && key[2] === serverId
    && (key[3] === "channel-meta" || key[3] === "forum-sidebar-retained") && key[4] === channelId) return true
  if (key[1] !== "message" && key[1] !== "reaction-details") return false
  const data = query.state.data as { channelId?: string; scope?: { channelId?: string } } | undefined
  const ownerChannelId = data?.channelId ?? data?.scope?.channelId
  return !ownerChannelId || ownerChannelId === channelId
}

function evictScopeContent(queryClient: QueryClient, serverId: string, channelId: string) {
  const predicate = (query: Query) => scopeQuery(query, serverId, channelId)
  void queryClient.cancelQueries({ predicate })
  queryClient.removeQueries({ predicate })
  useMessageStreamStore.getState().removeScope({ kind: "channel", id: channelId, serverId })
  const store = useCommunityStore.getState()
  for (const userId of store.typingByScope.get(`ch:${channelId}`)?.keys() ?? []) clearTypingIndicator(`ch:${channelId}`, userId)
  if (store.currentChannelId === channelId) {
    store.setCurrentChannelMeta(null)
    store.setCurrentChannelId(null)
  }
  if (store.subscription.channelId === channelId || store.subscription.secondaryChannelId === channelId) {
    const subscription = { ...store.subscription }
    if (subscription.channelId === channelId) delete subscription.channelId
    if (subscription.secondaryChannelId === channelId) delete subscription.secondaryChannelId
    useCommunityStore.setState({ subscription, ...(store.subscription.secondaryChannelId === channelId ? { secondaryChannelOwner: null } : {}) })
  }
}

export function evictServerChannelScopes(queryClient: QueryClient, serverId: string) {
  useCommunityWsStore.getState().revokeServerAccess(serverId)
  for (const id of collectChannelScopeIds(queryClient, serverId)) evictScopeContent(queryClient, serverId, id)
  void queryClient.cancelQueries({ queryKey: communityKeys.server(serverId) })
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
