import { getCommunityRuntime } from "@/stores/community/runtime"
import type {
  CommunityCategoryCreate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
  CommunityCategoryUpdate,
  CommunityChannelCreate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityChannelUpdate,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityInviteCreate,
  CommunityServerDelete,
  CommunityServerUpdate,
} from "@alook/shared"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCanonicalCommunityChannels, retireCommunityChannelReading } from "@/lib/community-db/sync"
import {
  grantForumSidebarChild,
  hasForumSidebarOwnershipEvidence,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
  reconcileForumSidebarArchiveTag,
  removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { StructureTreeEventContext } from "@/hooks/community/community-ws/handler-context"
import {
  projectForumPostUnitEviction,
} from "./channel-scope-projection"
import { evictServerChannelScopes } from "./scope-eviction"
import {
  invalidateChannelMessages,
  invalidateChannelRefDirectory,
  invalidateInvites,
  invalidateServerDetail,
  invalidateServersList,
  invalidateThreads,
} from "./invalidation-projections"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"

export function handleChildChannelCreate(event: CommunityChildChannelCreate, { projection }: StructureTreeEventContext) {
  invalidateThreads(projection, event.parentChannelId)
  if (event.parentMessageId) invalidateChannelMessages(projection, event.parentChannelId)
}

export function handleChildChannelUpdate(
  event: CommunityChildChannelUpdate,
  { queryClient, projection }: StructureTreeEventContext,
) {
  invalidateThreads(projection, event.parentChannelId)
  const changes = event.changes
  if (changes.tags !== undefined) {
    projection.fence("threads", {
      queryKey: communityKeys.threads(event.parentChannelId),
    })
    invalidateChannelMessages(projection, event.parentChannelId)
    projection.invalidate("forum-post-tags", {
      queryKey: communityKeys.forumTags(event.parentChannelId),
    })
  }
  const sidebarServerId = getCommunityRuntime(queryClient).ui.get().currentServerId
  if (
    sidebarServerId &&
    isForumSidebarParent(queryClient, sidebarServerId, event.parentChannelId)
  ) {
    if (changes.archived === true || changes.archived === false) {
      removeForumSidebarUnreadChild(queryClient, sidebarServerId, event.channelId)
      void reconcileForumSidebarArchiveTag(
        queryClient,
        sidebarServerId,
        event.channelId,
        changes.archived,
      )
      if (
        changes.archived === false
        && !hasForumSidebarOwnershipEvidence(queryClient, sidebarServerId, event.channelId)
      ) {
        void grantForumSidebarChild(queryClient, sidebarServerId, event.channelId)
          .catch(() => undefined)
      }
    } else if (changes.tags !== undefined) {
      void reconcileForumSidebarArchiveTag(
        queryClient,
        sidebarServerId,
        event.channelId,
        (changes.tags ?? []).includes(FORUM_ARCHIVE_TAG),
      )
    } else if (changes.lastMessageAt) {
      patchForumSidebarActivityExact(
        queryClient,
        sidebarServerId,
        event.channelId,
        event.parentChannelId,
        changes.lastMessageAt,
      )
    }
  }
  if (
    changes.archived === true &&
    getCommunityRuntime(queryClient).ui.get().currentChannelId === event.channelId
  ) {
    if (sidebarServerId) {
      queryClient.removeQueries({
        queryKey: communityKeys.channelMeta(sidebarServerId, event.channelId),
        exact: true,
      })
    }
  }
}

export function handleServerUpdate(
  event: CommunityServerUpdate,
  { projection }: StructureTreeEventContext,
) {
  invalidateChannelRefDirectory(projection)

}

export function handleServerDelete(
  event: CommunityServerDelete,
  { queryClient, projection }: StructureTreeEventContext,
) {
  evictServerChannelScopes(queryClient, event.serverId)
  invalidateChannelRefDirectory(projection)
  // Refresh the rail LIST only (drop the deleted server). `exact`
  // so this doesn't cascade-refetch every other server's nested
  // detail subtree.
  invalidateServersList(projection)
}

type ChannelEvent =
  | CommunityChannelCreate
  | CommunityChannelUpdate
  | CommunityChannelDelete
  | CommunityChannelReorder

export function handleChannelEvent(
  event: ChannelEvent,
  { queryClient, projection }: StructureTreeEventContext,
) {
  invalidateChannelRefDirectory(projection)
  // #3: on channel.delete, evict every channel-scoped cache before
  // invalidating the server. Without this the messages/pins/threads/
  // child-thread caches for the dead channel linger forever — a
  // subsequent same-id revive (rare, but the server can reuse ids)
  // would surface stale rows.
  if (event.type === "community:channel.delete") {
    const channels = getCanonicalCommunityChannels(queryClient)
    const child = channels.find((row) => row.id === event.channelId && row.serverId === event.serverId && row.parentChannelId === event.parentChannelId)
    const parent = channels.find((row) => row.id === event.parentChannelId && row.serverId === event.serverId && row.type === "forum")
    const openerMessageId = event.parentMessageId ?? (parent ? child?.parentMessageId : undefined)
    if (event.parentChannelId && openerMessageId) {
      projectForumPostUnitEviction(projection, queryClient, {
        serverId: event.serverId,
        forumChannelId: event.parentChannelId,
        childChannelId: event.channelId,
        openerMessageId,
      })
      invalidateChannelMessages(projection, event.parentChannelId)
      invalidateThreads(projection, event.parentChannelId)
      projection.invalidate("forum-post-delete:tags", {
        queryKey: communityKeys.forumTags(event.parentChannelId),
        exact: true,
      })
    } else {
      getActiveAccountUnreadProjection(queryClient).retireAccessScope({
        kind: "channel",
        channelId: event.channelId,
      })
      const registry = getCommunityDbRegistry(queryClient)
      if (registry) retireCommunityChannelReading(registry, event.channelId, { reason: "resource-deleted", serverId: event.serverId })
    }
    // When a child thread is deleted, refresh the
    // PARENT's list so the deleted card disappears from the feed on
    // every client. Absent on older events / top-level channels.
    if (event.parentChannelId && !openerMessageId) {
      invalidateChannelMessages(projection, event.parentChannelId)
      invalidateThreads(projection, event.parentChannelId)
    }
  }
  invalidateServerDetail(projection, event.serverId)
}

type CategoryEvent =
  | CommunityCategoryCreate
  | CommunityCategoryUpdate
  | CommunityCategoryDelete
  | CommunityCategoryReorder

export function handleCategoryEvent(
  event: CategoryEvent,
  { projection }: StructureTreeEventContext,
) {
  invalidateChannelRefDirectory(projection)
  invalidateServerDetail(projection, event.serverId)
}

export function handleInviteCreate(
  event: CommunityInviteCreate,
  { projection }: StructureTreeEventContext,
) {
  invalidateInvites(projection, event.serverId)
}
