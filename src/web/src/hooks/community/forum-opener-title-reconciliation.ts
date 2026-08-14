"use client"

import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import type { UnreadServer } from "@/lib/community/models/inbox"
import type { ThreadsResponse } from "@/hooks/community/use-channel-panels"
import type { ForumActivityPage } from "@/hooks/community/use-forum-feed"
import {
  getForumSidebarBase,
  patchForumSidebarTitleExact,
  type ChildChannelMeta,
  type ForumOpenerHint,
  type ForumSidebarThread,
} from "@/hooks/community/use-forum-sidebar-threads"
import { patchMessageContentInCache } from "@/hooks/community/community-ws/cache"
import { useMessageStreamStore } from "@/stores/community/message-stream"

type PageCache = InfiniteData<MessagesPage>

export type ForumOpenerTitleIdentity = {
  serverId: string
  forumChannelId: string
  childChannelId: string
  openerMessageId: string
  content: string
}

function patchInbox(
  data: { servers: UnreadServer[]; dms: unknown[] } | undefined,
  identity: ForumOpenerTitleIdentity,
) {
  if (!data) return data
  let touched = false
  const servers = data.servers.map((server) => {
    if (server.serverId !== identity.serverId) return server
    return {
      ...server,
      channels: server.channels.map((channel) => {
        if (channel.channelId !== identity.forumChannelId) return channel
        return {
          ...channel,
          children: channel.children.map((child) => {
            if (
              child.channelId !== identity.childChannelId ||
              child.openerMessageId !== identity.openerMessageId
            ) return child
            touched = true
            return { ...child, channelName: identity.content }
          }),
        }
      }),
    }
  })
  return touched ? { ...data, servers } : data
}

function patchActivity(
  data: InfiniteData<ForumActivityPage> | undefined,
  identity: ForumOpenerTitleIdentity,
) {
  if (!data) return data
  let touched = false
  const pages = data.pages.map((page) => ({
    ...page,
    included: {
      ...page.included,
      parentMessages: page.included.parentMessages.map((message) => {
        if (
          page.serverId !== identity.serverId ||
          message.id !== identity.openerMessageId ||
          message.channelId !== identity.forumChannelId
        ) return message
        touched = true
        return { ...message, content: identity.content }
      }),
    },
  }))
  return touched ? { ...data, pages } : data
}

function sidebarIdentityMatches(queryClient: QueryClient, identity: ForumOpenerTitleIdentity) {
  const meta = queryClient.getQueryData<ChildChannelMeta>(
    communityKeys.channelMeta(identity.serverId, identity.childChannelId),
  )
  if (meta) {
    return meta.parentChannelId === identity.forumChannelId &&
      meta.parentMessageId === identity.openerMessageId
  }
  const base = getForumSidebarBase(queryClient, identity.serverId)?.threads
    .find((thread) => thread.id === identity.childChannelId)
  if (base) {
    return base.parentChannelId === identity.forumChannelId &&
      base.parentMessageId === identity.openerMessageId
  }
  const retained = queryClient.getQueryData<ForumSidebarThread | null>(
    communityKeys.forumSidebarRetained(identity.serverId, identity.childChannelId),
  )
  return !!retained && retained.parentChannelId === identity.forumChannelId &&
    retained.parentMessageId === identity.openerMessageId
}

export async function reconcileForumOpenerTitle(
  queryClient: QueryClient,
  identity: ForumOpenerTitleIdentity,
) {
  const inboxKey = communityKeys.inboxUnreads()
  const threadsKey = communityKeys.threads(identity.forumChannelId)

  await Promise.all([
    queryClient.cancelQueries({ queryKey: inboxKey, exact: true }),
    queryClient.cancelQueries({ queryKey: threadsKey, exact: true }),
  ])

  // A loaded base-threads response is server-authorized and carries the full
  // forum/child/opener identity. Treat any mismatch as an untrusted/stale
  // event and stop before touching even the message-shaped title caches.
  const loadedThreads = queryClient.getQueryData<ThreadsResponse>(threadsKey)
  if (loadedThreads) {
    const loadedChild = loadedThreads.threads.find(
      (thread) => thread.id === identity.childChannelId,
    )
    if (
      loadedThreads.serverId !== identity.serverId ||
      loadedThreads.parentType !== "forum" ||
      loadedThreads.parentChannelId !== identity.forumChannelId ||
      (loadedChild !== undefined && loadedChild.openerMessageId !== identity.openerMessageId)
    ) return
  }
  const loadedInbox = queryClient.getQueryData<{ servers: UnreadServer[] }>(inboxKey)
  const knownInboxIdentity = loadedInbox?.servers.flatMap((server) =>
    server.channels.flatMap((channel) => channel.children.map((child) => ({
      serverId: server.serverId,
      forumChannelId: channel.channelId,
      childChannelId: child.channelId,
      openerMessageId: child.openerMessageId,
    }))),
  ).find((row) =>
    row.childChannelId === identity.childChannelId ||
    row.openerMessageId === identity.openerMessageId,
  )
  if (knownInboxIdentity && (
    knownInboxIdentity.serverId !== identity.serverId ||
    knownInboxIdentity.forumChannelId !== identity.forumChannelId ||
    knownInboxIdentity.childChannelId !== identity.childChannelId ||
    knownInboxIdentity.openerMessageId !== identity.openerMessageId
  )) return

  queryClient.setQueryData<Msg | undefined>(
    communityKeys.message(identity.openerMessageId),
    (message) => message ? { ...message, content: identity.content } : message,
  )
  for (const channelId of [identity.forumChannelId, identity.childChannelId]) {
    queryClient.setQueriesData<PageCache>(
      { queryKey: communityKeys.channelMessages(channelId) },
      (cache) => patchMessageContentInCache(cache, identity.openerMessageId, identity.content),
    )
  }
  queryClient.setQueriesData<InfiniteData<ForumActivityPage>>(
    { queryKey: [...communityKeys.threads(identity.forumChannelId), "activity"] },
    (data) => patchActivity(data, identity),
  )
  queryClient.setQueryData<{ servers: UnreadServer[]; dms: unknown[] }>(
    inboxKey,
    (data) => patchInbox(data, identity),
  )
  queryClient.setQueryData<ThreadsResponse>(threadsKey, (data) => {
    if (
      !data ||
      data.serverId !== identity.serverId ||
      data.parentType !== "forum" ||
      data.parentChannelId !== identity.forumChannelId
    ) return data
    let touched = false
    const threads = data.threads.map((thread) => {
      if (
        thread.id !== identity.childChannelId ||
        thread.openerMessageId !== identity.openerMessageId
      ) return thread
      touched = true
      return { ...thread, name: identity.content }
    })
    return touched ? { ...data, threads } : data
  })

  if (sidebarIdentityMatches(queryClient, identity)) {
    patchForumSidebarTitleExact(
      queryClient,
      identity.serverId,
      identity.childChannelId,
      identity.content,
    )
  }
  queryClient.setQueryData<ForumOpenerHint | undefined>(
    communityKeys.forumOpenerHint(identity.serverId, identity.openerMessageId),
    (hint) => hint?.id === identity.openerMessageId
      ? { ...hint, content: identity.content }
      : hint,
  )

  const streamStore = useMessageStreamStore.getState()
  for (const entry of streamStore.entries.values()) {
    if (
      entry.scope.kind !== "channel" ||
      entry.scope.serverId !== identity.serverId ||
      (entry.scope.id !== identity.forumChannelId && entry.scope.id !== identity.childChannelId)
    ) continue
    streamStore.dispatch(entry.scope, {
      type: "messageEdited",
      messageId: identity.openerMessageId,
      content: identity.content,
    })
  }

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: inboxKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: threadsKey, exact: true }),
  ])
}
