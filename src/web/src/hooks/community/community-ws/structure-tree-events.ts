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
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import type { CanonicalMessage } from "@/lib/community/message-stream"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"
import {
  grantForumSidebarChild,
  isForumSidebarParent,
  isKnownNonForumSidebarChannel,
  patchForumSidebarActivityExact,
  removeForumSidebarChildrenForParent,
  removeForumSidebarThreadExact,
  removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import {
  findCachedMessage,
  removeThreadFromCache,
  type PageCache,
} from "@/hooks/community/community-ws/cache"
import type { StructureTreeEventContext } from "@/hooks/community/community-ws/handler-context"

export function handleChildChannelCreate(
  event: CommunityChildChannelCreate,
  { queryClient }: StructureTreeEventContext,
) {
  // Cheap invalidate for the child-thread lists. The parent
  // messages list also needs an update because the parent message's
  // thread indicator (`msg.thread`) changes — do a targeted
  // setQueryData patch when we know parentMessageId.
  void queryClient.invalidateQueries({
    queryKey: communityKeys.threads(event.parentChannelId),
  })
  const parentMessagesKey = communityKeys.channelMessages(event.parentChannelId)
  const parentMessages = queryClient.getQueryData<PageCache>(parentMessagesKey)
  const openerCached = !!event.parentMessageId && parentMessages?.pages.some((page) =>
    page.messages.some((message) => message.id === event.parentMessageId),
  )
  if (event.parentMessageId) {
    queryClient.setQueriesData<PageCache>(
      { queryKey: parentMessagesKey },
      (cache) => {
        if (!cache) return cache
        let touched = false
        const pages = cache.pages.map((p) => {
          if (!p.messages.some((m) => m.id === event.parentMessageId)) return p
          touched = true
          return {
            ...p,
            messages: p.messages.map((m) =>
              m.id === event.parentMessageId
                ? {
                  ...m,
                  thread: {
                    id: event.channel.id,
                    name: event.channel.name,
                    // #4: a freshly-created child channel has no
                    // messages yet — `1` was a false claim that
                    // the create event carried the first message
                    // (it doesn't; the message arrives separately).
                    messageCount: 0,
                  },
                }
                : m,
            ),
          }
        })
        if (!touched) return cache
        return { ...cache, pages }
      },
    )
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.id === event.parentMessageId)
      if (fallback) {
        const cached = findCachedMessage(
          queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.parentChannelId)),
          event.parentMessageId,
        )
        const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
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
    void queryClient.invalidateQueries({ queryKey: parentMessagesKey })
  }
}

export function handleChildChannelUpdate(
  event: CommunityChildChannelUpdate,
  { queryClient }: StructureTreeEventContext,
) {
  // Cheap invalidate for the child-thread lists. The parent
  // messages list also needs an update because the parent message's
  // thread indicator (`msg.thread`) changes — do a targeted
  // setQueryData patch when we know parentMessageId.
  void queryClient.invalidateQueries({
    queryKey: communityKeys.threads(event.parentChannelId),
  })
  // child_update — sync counts/name on the parent message's thread
  // indicator if the update carries them.
  const changes = event.changes
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
    if (changes.archived === true) {
      removeForumSidebarUnreadChild(queryClient, sidebarServerId, event.channelId)
      removeForumSidebarThreadExact(queryClient, sidebarServerId, event.channelId)
    } else if (changes.archived === false) {
      void grantForumSidebarChild(queryClient, sidebarServerId, event.channelId)
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
    queryClient.setQueriesData<PageCache>(
      { queryKey: communityKeys.channelMessages(event.parentChannelId) },
      (cache) => {
        if (!cache) return cache
        let touched = false
        const pages = cache.pages.map((p) => {
          if (!p.messages.some((m) => m.thread?.id === event.channelId)) return p
          touched = true
          return {
            ...p,
            messages: p.messages.map((m) =>
              m.thread?.id === event.channelId
                ? {
                  ...m,
                  thread: {
                    ...m.thread,
                    ...(changes.name !== undefined ? { name: changes.name } : {}),
                    ...(changes.messageCount !== undefined
                      ? { messageCount: changes.messageCount }
                      : {}),
                  },
                }
                : m,
            ),
          }
        })
        if (!touched) return cache
        return { ...cache, pages }
      },
    )
    const serverId = useCommunityStore.getState().currentServerId
    if (serverId) {
      const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.thread?.id === event.channelId)
      if (fallback?.thread) {
        const cached = findCachedMessage(
          queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.parentChannelId)),
          fallback.id,
        )
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
  { queryClient }: StructureTreeEventContext,
) {
  queryClient.setQueryData<ServerDetail | undefined>(
    communityKeys.server(event.serverId),
    (prev) =>
      prev
        ? {
          ...prev,
          name: event.changes.name ?? prev.name,
          description: event.changes.description ?? prev.description,
          // #8: icon can be explicitly cleared (null). `??` treats
          // null the same as undefined, which would keep the old
          // icon after a removal — check `undefined` explicitly.
          icon:
            event.changes.icon !== undefined
              ? event.changes.icon
              : prev.icon,
        }
        : prev,
  )
  queryClient.setQueryData<ServersResponse | undefined>(
    communityKeys.servers(),
    (prev) =>
      prev
        ? {
          ...prev,
          servers: prev.servers.map((s) =>
            s.id === event.serverId
              ? {
                ...s,
                ...(event.changes.name ? { name: event.changes.name, initial: avatarInitial(event.changes.name) } : {}),
                ...(event.changes.icon !== undefined ? { icon: event.changes.icon ?? null } : {}),
              }
              : s,
          ),
        }
        : prev,
  )
}

export function handleServerDelete(
  event: CommunityServerDelete,
  { queryClient }: StructureTreeEventContext,
) {
  // Refresh the rail LIST only (drop the deleted server). `exact`
  // so this doesn't cascade-refetch every other server's nested
  // detail subtree; the deleted server's own subtree is cleared by
  // the removeQueries below.
  void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
  queryClient.removeQueries({ queryKey: communityKeys.server(event.serverId) })
  // #10: if the deleted server is the one the viewer is looking at,
  // the store pointers now dangle — reset them so the UI drops back
  // to a safe default instead of rendering a ghost server/channel.
  const store = useCommunityStore.getState()
  useMessageStreamStore.getState().removeServer(event.serverId)
  if (store.currentServerId === event.serverId) {
    store.setCurrentChannelMeta(null)
    store.setCurrentChannelId(null)
    store.setCurrentServerId(null)
  }
}

type ChannelEvent =
  | CommunityChannelCreate
  | CommunityChannelUpdate
  | CommunityChannelDelete
  | CommunityChannelReorder

export function handleChannelEvent(
  event: ChannelEvent,
  { queryClient }: StructureTreeEventContext,
) {
  // #3: on channel.delete, evict every channel-scoped cache before
  // invalidating the server. Without this the messages/pins/threads/
  // child-thread caches for the dead channel linger forever — a
  // subsequent same-id revive (rare, but the server can reuse ids)
  // would surface stale rows.
  if (event.type === "community:channel.delete") {
    const nonForum = isKnownNonForumSidebarChannel(
      queryClient,
      event.serverId,
      event.channelId,
    )
    if (!nonForum) {
      removeForumSidebarUnreadChild(queryClient, event.serverId, event.channelId)
      removeForumSidebarChildrenForParent(queryClient, event.serverId, event.channelId)
      removeForumSidebarThreadExact(queryClient, event.serverId, event.channelId)
    } else {
      queryClient.removeQueries({
        queryKey: communityKeys.channelMeta(event.serverId, event.channelId),
        exact: true,
      })
    }
    if (useCommunityStore.getState().currentChannelId === event.channelId) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
    }
    useMessageStreamStore.getState().removeScope({
      kind: "channel",
      id: event.channelId,
      serverId: event.serverId,
    })
    queryClient.removeQueries({
      queryKey: communityKeys.channelMessages(event.channelId),
    })
    queryClient.removeQueries({
      queryKey: communityKeys.pins(event.channelId),
    })
    queryClient.removeQueries({
      queryKey: communityKeys.threads(event.channelId),
    })
    // When a child thread is deleted, refresh the
    // PARENT's list so the deleted card disappears from the feed on
    // every client. Absent on older events / top-level channels.
    if (event.parentChannelId) {
      queryClient.setQueriesData<PageCache>(
        { queryKey: communityKeys.channelMessages(event.parentChannelId) },
        (cache) => removeThreadFromCache(cache, event.channelId),
      )
      void queryClient.invalidateQueries({
        queryKey: communityKeys.channelMessages(event.parentChannelId),
      })
      void queryClient.invalidateQueries({
        queryKey: communityKeys.threads(event.parentChannelId),
      })
    }
  }
  void queryClient.invalidateQueries({
    queryKey: communityKeys.server(event.serverId),
    exact: true,
  })
}

type CategoryEvent =
  | CommunityCategoryCreate
  | CommunityCategoryUpdate
  | CommunityCategoryDelete
  | CommunityCategoryReorder

export function handleCategoryEvent(
  event: CategoryEvent,
  { queryClient }: StructureTreeEventContext,
) {
  void queryClient.invalidateQueries({
    queryKey: communityKeys.server(event.serverId),
    exact: true,
  })
}

export function handleInviteCreate(
  event: CommunityInviteCreate,
  { queryClient }: StructureTreeEventContext,
) {
  void queryClient.invalidateQueries({
    queryKey: communityKeys.invites(event.serverId),
    exact: true,
  })
}
