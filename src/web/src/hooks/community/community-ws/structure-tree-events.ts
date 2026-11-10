import { refreshForumPostCounts } from "../use-forum-post-counts"
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
import { supportsSidebarThreads } from "@/lib/community/forum-sidebar"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCanonicalCommunityChannels, retireCommunityChannelReading } from "@/lib/community-db/sync"
import {
  grantForumSidebarChild,
  getForumSidebarBase,
  hasForumSidebarOwnershipEvidence,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
  reconcileForumSidebarArchiveTag,
} from "@/hooks/community/use-forum-sidebar-threads"
import type { StructureTreeEventContext } from "@/hooks/community/community-ws/handler-context"
import {
  projectForumPostUnitEviction,
} from "./channel-scope-projection"
import { evictServerChannelScopes } from "./scope-eviction"
import {
  invalidateChannelMessages,
  invalidateForumSidebar,
  invalidateChannelRefDirectory,
  invalidateChannelRefTargets,
  invalidateInvites,
  invalidateServerDetail,
  invalidateServersList,
  invalidateThreads,
} from "./invalidation-projections"

export function handleChildChannelCreate(event: CommunityChildChannelCreate, { queryClient, projection }: StructureTreeEventContext) {
  invalidateChannelRefTargets(projection, { channelId: event.channel.id })
  const parent = getCanonicalCommunityChannels(queryClient).find(row => row.id === event.parentChannelId && supportsSidebarThreads(row.type))
  if (parent?.serverId) {
    invalidateForumSidebar(projection, parent.serverId)
    if (parent.type === "forum") refreshForumPostCounts(queryClient, parent.serverId)
  }
  projection.fence("threads", { queryKey: communityKeys.threads(event.parentChannelId) })
  if (event.parentMessageId) invalidateChannelMessages(projection, event.parentChannelId)
}

export function handleChildChannelUpdate(
  event: CommunityChildChannelUpdate,
  { queryClient, projection }: StructureTreeEventContext,
) {
  invalidateThreads(projection, event.parentChannelId)
  const changes = event.changes
  if (changes.archived !== undefined || changes.tags !== undefined) {
    const parent = getCanonicalCommunityChannels(queryClient).find(row => row.id === event.parentChannelId && row.type === "forum")
    if (parent?.serverId) refreshForumPostCounts(queryClient, parent.serverId)
  }
  if (changes.name !== undefined || changes.archived !== undefined || changes.tags !== undefined) invalidateChannelRefTargets(projection, { channelId: event.channelId })
  if (changes.tags !== undefined) {
    projection.fence("threads", {
      queryKey: communityKeys.threads(event.parentChannelId),
    })
    invalidateChannelMessages(projection, event.parentChannelId)
    projection.fence("forum-post-tags", {
      queryKey: communityKeys.forumTags(event.parentChannelId),
    })
  }
  const sidebarServerId = getCanonicalCommunityChannels(queryClient).find(row => row.id === event.parentChannelId && supportsSidebarThreads(row.type))?.serverId
  if (
    sidebarServerId &&
    isForumSidebarParent(queryClient, sidebarServerId, event.parentChannelId)
  ) {
    if (changes.archived === true || changes.archived === false) {
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
      if (!getForumSidebarBase(queryClient, sidebarServerId).threads.some(thread => thread.id === event.channelId)) {
        invalidateForumSidebar(projection, sidebarServerId)
      }
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
        queryKey: communityKeys.conversationEntries(event.channelId),
      })
    }
  }
}

export function handleServerUpdate(
  event: CommunityServerUpdate,
  { projection }: StructureTreeEventContext,
) {
  invalidateChannelRefDirectory(projection, { serverId: event.serverId })

}

export function handleServerDelete(
  event: CommunityServerDelete,
  { queryClient, projection }: StructureTreeEventContext,
) {
  evictServerChannelScopes(queryClient, event.serverId)
  invalidateChannelRefDirectory(projection, { serverId: event.serverId })

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
  invalidateChannelRefDirectory(projection, { serverId: event.serverId, channelId: event.type === "community:channel.create" ? event.channel.id : "channelId" in event ? event.channelId : undefined })

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
      const registry = getCommunityDbRegistry(queryClient)
      if (registry) retireCommunityChannelReading(registry, event.channelId, { reason: "resource-deleted", serverId: event.serverId })
    }

    if (event.parentChannelId && !openerMessageId) {
      invalidateChannelMessages(projection, event.parentChannelId)
      invalidateThreads(projection, event.parentChannelId)
    }
  }
  refreshForumPostCounts(queryClient, event.serverId)
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
  invalidateChannelRefDirectory(projection, { serverId: event.serverId })
  invalidateServerDetail(projection, event.serverId)
}

export function handleInviteCreate(
  event: CommunityInviteCreate,
  { projection }: StructureTreeEventContext,
) {
  invalidateInvites(projection, event.serverId)
}
