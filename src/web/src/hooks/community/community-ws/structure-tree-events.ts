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
import type { CanonicalMessage } from "@/lib/community/message-stream"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  applyCommunityServerPatch,
  getCommunityDbRegistry,
} from "@/lib/community-db/collections"
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
  projectChannelScopeEviction,
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
import { projectForumFeedWsTags } from "@/hooks/community/forum-feed-tag-transition"

export function handleChildChannelCreate(
  event: CommunityChildChannelCreate,
  { queryClient, projection }: StructureTreeEventContext,
) {
  // Cheap invalidate for the child-thread lists. The parent
  // messages list also needs an update because the parent message's
  // thread indicator (`msg.thread`) changes — do a targeted
  // setQueryData patch when we know parentMessageId.
  invalidateThreads(projection, event.parentChannelId)
  const registry = getCommunityDbRegistry(queryClient)
  const opener = event.parentMessageId
    ? registry?.collections.messages.get(event.parentMessageId)
    : undefined
  const openerCached = opener !== undefined
  if (event.parentMessageId) {
    if (registry && opener) {
      registry.collections.messages.utils.writeUpdate({
        id: event.parentMessageId,
        thread: {
          id: event.channel.id,
          name: event.channel.name,
          messageCount: 0,
        },
      })
    }
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.id === event.parentMessageId)
      if (fallback) {
        const source = opener?.seq !== undefined ? opener as CanonicalMessage : fallback
        useMessageStreamStore.getState().dispatch(scope, {
          type: "liveRefreshed",
          message: {
            ...source,
            thread: { id: event.channel.id, name: event.channel.name, messageCount: 0 },
          },
        })
      }
    }
  }
  if (event.parentMessageId && !openerCached) {
    invalidateChannelMessages(projection, event.parentChannelId)
  }
}

export function handleChildChannelUpdate(
  event: CommunityChildChannelUpdate,
  { queryClient, projection }: StructureTreeEventContext,
) {
  // Cheap invalidate for the child-thread lists. The parent
  // messages list also needs an update because the parent message's
  // thread indicator (`msg.thread`) changes — do a targeted
  // setQueryData patch when we know parentMessageId.
  invalidateThreads(projection, event.parentChannelId)
  // child_update — sync counts/name on the parent message's thread
  // indicator if the update carries them.
  const changes = event.changes
  if (changes.tags !== undefined) {
    projection.fence("threads", {
      queryKey: communityKeys.threads(event.parentChannelId),
    })
    projection.project(() => projectForumFeedWsTags(queryClient, {
      forumChannelId: event.parentChannelId,
      threadId: event.channelId,
      tags: changes.tags ?? [],
    }))
    invalidateChannelMessages(projection, event.parentChannelId)
    projection.invalidate("forum-post-tags", {
      queryKey: communityKeys.forumTags(event.parentChannelId),
    })
  }
  const sidebarServerId = useCommunityStore.getState().currentServerId
  if (changes.name !== undefined && sidebarServerId) {
    queryClient.setQueryData<Record<string, unknown> | undefined>(
      communityKeys.channelMeta(sidebarServerId, event.channelId),
      (meta) => meta ? { ...meta, name: changes.name } : meta,
    )
    const store = useCommunityStore.getState()
    if (
      store.currentChannelId === event.channelId &&
      store.currentChannelMeta &&
      store.currentChannelMeta.name !== changes.name
    ) {
      store.setCurrentChannelMeta({ ...store.currentChannelMeta, name: changes.name })
    }
  }
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
    useCommunityStore.getState().currentChannelId === event.channelId
  ) {
    useCommunityStore.getState().setCurrentChannelMeta(null)
    if (sidebarServerId) {
      queryClient.removeQueries({
        queryKey: communityKeys.channelMeta(sidebarServerId, event.channelId),
        exact: true,
      })
    }
  }
  if (changes.messageCount !== undefined || changes.name !== undefined) {
    const registry = getCommunityDbRegistry(queryClient)
    const canonical = [...(registry?.collections.messages.values() ?? [])]
      .map((message) => message as CanonicalMessage)
      .filter((message) => message.thread?.id === event.channelId)
    if (registry && canonical.length > 0) {
      registry.collections.messages.utils.writeBatch(() => {
        for (const message of canonical) {
          registry.collections.messages.utils.writeUpdate({
            id: message.id,
            thread: {
              ...message.thread!,
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...(changes.messageCount !== undefined
                ? { messageCount: changes.messageCount }
                : {}),
            },
          })
        }
      })
    }
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.thread?.id === event.channelId)
      if (fallback?.thread) {
        const cached = canonical.find((message) => message.id === fallback.id)
        const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
        useMessageStreamStore.getState().dispatch(scope, {
          type: "liveRefreshed",
          message: {
            ...source,
            thread: {
              ...(source.thread ?? fallback.thread),
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...(changes.messageCount !== undefined ? { messageCount: changes.messageCount } : {}),
            },
          },
        })
      }
    }
  }
}

export function handleServerUpdate(
  event: CommunityServerUpdate,
  { queryClient, projection }: StructureTreeEventContext,
) {
  invalidateChannelRefDirectory(projection)
  applyCommunityServerPatch(queryClient, event.serverId, event.changes)
}

export function handleServerDelete(
  event: CommunityServerDelete,
  { queryClient, projection }: StructureTreeEventContext,
) {
  evictServerChannelScopes(queryClient, event.serverId)
  getActiveAccountUnreadProjection(queryClient).retireAccessScope({
    kind: "server",
    serverId: event.serverId,
  })
  invalidateChannelRefDirectory(projection)
  // Refresh the rail LIST only (drop the deleted server). `exact`
  // so this doesn't cascade-refetch every other server's nested
  // detail subtree; the deleted server's own subtree is cleared by
  // the removeQueries below.
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
    if (event.parentChannelId && event.parentMessageId) {
      projectForumPostUnitEviction(projection, queryClient, {
        serverId: event.serverId,
        forumChannelId: event.parentChannelId,
        childChannelId: event.channelId,
        openerMessageId: event.parentMessageId,
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
      projectChannelScopeEviction(
        projection,
        queryClient,
        event.serverId,
        event.channelId,
      )
    }
    // When a child thread is deleted, refresh the
    // PARENT's list so the deleted card disappears from the feed on
    // every client. Absent on older events / top-level channels.
    if (event.parentChannelId && !event.parentMessageId) {
      const registry = getCommunityDbRegistry(queryClient)
      const parents = [...(registry?.collections.messages.values() ?? [])]
        .map((message) => message as CanonicalMessage)
        .filter((message) => message.thread?.id === event.channelId)
      if (registry && parents.length > 0) {
        registry.collections.messages.utils.writeBatch(() => {
          for (const parent of parents) {
            registry.collections.messages.utils.writeUpdate({
              id: parent.id,
              thread: undefined,
            })
          }
        })
      }
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
