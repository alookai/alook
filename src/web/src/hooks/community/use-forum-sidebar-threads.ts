"use client"

import { useEffect } from "react"
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { patchChannelUnread } from "@/hooks/community/server-detail-cache"
import type { ServerDetail } from "@/hooks/community/use-servers"

export type ForumSidebarThread = {
  id: string
  parentChannelId: string
  parentMessageId: string
  title: string
  activityAt: string
  expiresAt: string
  unread: boolean
}

export type SidebarThreadEnvelope = {
  channels: Array<{
    id: string
    name: string
    parentChannelId: string | null
    parentMessageId: string | null
    activityAt: string
    expiresAt: string
    unread: boolean
  }>
  included: {
    parentMessages: Array<{ id: string; content: string }>
  }
  serverNow: string
}

export type ForumSidebarQueryData = SidebarThreadEnvelope & {
  threads: ForumSidebarThread[]
  /** Server clock minus client clock, captured when this envelope arrived. */
  serverClockOffsetMs: number
}

export type ForumSidebarUnreadFallbackState = Record<string, {
  baseUnread: boolean
  childIds: string[]
}>

const SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000

function parentUnread(cache: ServerDetail | undefined, parentChannelId: string): boolean {
  return !!cache?.categories.some((category) =>
    category.channels.some((channel) => channel.id === parentChannelId && channel.unread),
  )
}

/** Record canonical child unread ownership and project it to the loaded row or parent fallback. */
export function recordForumSidebarChildUnread(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
  childChannelId: string,
  loaded = false,
) {
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  const serverKey = communityKeys.server(serverId)
  const cachedServer = queryClient.getQueryData<ServerDetail>(serverKey)
  const canonicalBaseUnread = cachedServer?.forumUnreadState?.[parentChannelId]?.baseUnread
    ?? parentUnread(cachedServer, parentChannelId)
  queryClient.setQueryData<ServerDetail | undefined>(serverKey, (cache) => {
    if (!cache) return cache
    const current = cache.forumUnreadState?.[parentChannelId]
    const baseUnread = current?.baseUnread ?? canonicalBaseUnread
    const childIds = current?.childIds.includes(childChannelId)
      ? current.childIds
      : [...(current?.childIds ?? []), childChannelId]
    const next = {
      ...cache,
      forumUnreadState: {
        ...cache.forumUnreadState,
        [parentChannelId]: { baseUnread, childIds },
      },
    }
    const hidden = (queryClient.getQueryData<ForumSidebarUnreadFallbackState>(key)
      ?.[parentChannelId]?.childIds ?? [])
      .filter((id) => !loaded || id !== childChannelId)
    return patchChannelUnread(
      next,
      parentChannelId,
      baseUnread || !loaded || hidden.length > 0,
    )
  })
  queryClient.setQueryData<ForumSidebarUnreadFallbackState>(key, (state = {}) => {
    const current = state[parentChannelId]
    const baseUnread = current?.baseUnread ?? canonicalBaseUnread
    const childIds = loaded
      ? (current?.childIds ?? []).filter((id) => id !== childChannelId)
      : current?.childIds.includes(childChannelId)
        ? current.childIds
        : [...(current?.childIds ?? []), childChannelId]
    if (childIds.length === 0) {
      if (!current) return state
      const next = { ...state }
      delete next[parentChannelId]
      return next
    }
    return {
      ...state,
      [parentChannelId]: { baseUnread, childIds },
    }
  })
}

/** Update the genuine parent contribution while preserving missing children. */
export function setForumSidebarParentUnreadBase(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
  unread: boolean,
): boolean {
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  const state = queryClient.getQueryData<ForumSidebarUnreadFallbackState>(key)
  const current = state?.[parentChannelId]
  let handled = false
  queryClient.setQueryData<ServerDetail | undefined>(communityKeys.server(serverId), (cache) => {
    if (!cache?.forumUnreadState?.[parentChannelId]) return cache
    handled = true
    const entry = cache.forumUnreadState[parentChannelId]!
    return patchChannelUnread({
      ...cache,
      forumUnreadState: {
        ...cache.forumUnreadState,
        [parentChannelId]: { ...entry, baseUnread: unread },
      },
    }, parentChannelId, unread || (current?.childIds.length ?? 0) > 0)
  })
  if (current) {
    queryClient.setQueryData<ForumSidebarUnreadFallbackState>(key, {
      ...state,
      [parentChannelId]: { ...current, baseUnread: unread },
    })
    handled = true
  }
  return handled
}

/**
 * Re-project fallback ownership from the canonical unread child set. Loaded
 * children own their own dots; only unread children omitted by the sidebar's
 * 72h / top-five projection light the parent. Re-deriving (rather than merely
 * removing loaded ids) is what preserves visible → hidden transitions.
 */
export function reconcileForumSidebarUnreadFallbacks(
  queryClient: QueryClient,
  serverId: string,
  loadedChildIds: Iterable<string>,
) {
  const loaded = new Set(loadedChildIds)
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  let fallbackState: ForumSidebarUnreadFallbackState = {}
  queryClient.setQueryData<ServerDetail | undefined>(communityKeys.server(serverId), (cache) => {
    if (!cache?.forumUnreadState) return cache
    let next: ServerDetail | undefined = cache
    for (const [parentChannelId, entry] of Object.entries(cache.forumUnreadState)) {
      const childIds = entry.childIds.filter((id) => !loaded.has(id))
      if (childIds.length > 0) {
        fallbackState = {
          ...fallbackState,
          [parentChannelId]: { baseUnread: entry.baseUnread, childIds },
        }
      }
      next = patchChannelUnread(
        next,
        parentChannelId,
        entry.baseUnread || childIds.length > 0,
      )
    }
    return next
  })
  queryClient.setQueryData(key, fallbackState)
}

/** Remove a child's canonical unread ownership after read/leave/delete/archive. */
export function removeForumSidebarUnreadChild(
  queryClient: QueryClient,
  serverId: string,
  childChannelId: string,
) {
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  queryClient.setQueryData<ForumSidebarUnreadFallbackState>(key, (state = {}) => {
    let next = state
    for (const [parentChannelId, entry] of Object.entries(state)) {
      if (!entry.childIds.includes(childChannelId)) continue
      const childIds = entry.childIds.filter((id) => id !== childChannelId)
      next = { ...state }
      if (childIds.length === 0) delete next[parentChannelId]
      else next[parentChannelId] = { ...entry, childIds }
      break
    }
    return next
  })
  queryClient.setQueryData<ServerDetail | undefined>(communityKeys.server(serverId), (cache) => {
    if (!cache?.forumUnreadState) return cache
    const found = Object.entries(cache.forumUnreadState)
      .find(([, entry]) => entry.childIds.includes(childChannelId))
    if (!found) return cache
    const [parentChannelId, entry] = found
    const childIds = entry.childIds.filter((id) => id !== childChannelId)
    const next = {
      ...cache,
      forumUnreadState: {
        ...cache.forumUnreadState,
        [parentChannelId]: { ...entry, childIds },
      },
    }
    const hiddenChildIds = queryClient
      .getQueryData<ForumSidebarUnreadFallbackState>(key)
      ?.[parentChannelId]?.childIds ?? []
    const unread = entry.baseUnread || hiddenChildIds.length > 0
    return patchChannelUnread(next, parentChannelId, unread)
  })
}

export function hasForumSidebarThread(data: ForumSidebarQueryData | undefined, threadId: string) {
  return !!data?.threads.some((thread) => thread.id === threadId)
}

export function patchForumSidebarActivity(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
  parentChannelId: string,
  activityAt: string,
): ForumSidebarQueryData | undefined {
  if (!data || !hasForumSidebarThread(data, threadId)) return data
  const expiresAt = new Date(Date.parse(activityAt) + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
  const threads = data.threads
    .map((thread) => thread.id === threadId ? { ...thread, activityAt, expiresAt } : thread)
    .sort((a, b) => {
      if (a.parentChannelId !== b.parentChannelId) return a.parentChannelId < b.parentChannelId ? -1 : 1
      if (a.activityAt !== b.activityAt) return a.activityAt > b.activityAt ? -1 : 1
      return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
    })
  // Ignore metadata from a malformed/mismatched event rather than moving the
  // loaded row under a different forum. The event's parent id is still checked
  // by callers before deciding whether a missing row requires a refetch.
  if (!threads.some((thread) => thread.id === threadId && thread.parentChannelId === parentChannelId)) return data
  return { ...data, threads }
}

export function patchForumSidebarTitle(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
  title: string,
): ForumSidebarQueryData | undefined {
  if (!data) return data
  return {
    ...data,
    threads: data.threads.map((thread) => thread.id === threadId ? { ...thread, title } : thread),
  }
}

export function patchForumSidebarUnread(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
  unread: boolean,
): ForumSidebarQueryData | undefined {
  if (!data || !hasForumSidebarThread(data, threadId)) return data
  return {
    ...data,
    threads: data.threads.map((thread) => thread.id === threadId ? { ...thread, unread } : thread),
  }
}

export function removeForumSidebarThread(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
): ForumSidebarQueryData | undefined {
  if (!data) return data
  return { ...data, threads: data.threads.filter((thread) => thread.id !== threadId) }
}

export function projectForumSidebarThreads(data: SidebarThreadEnvelope): ForumSidebarThread[] {
  const openerById = new Map(data.included.parentMessages.map((message) => [message.id, message]))
  return data.channels.flatMap((channel) => {
    if (!channel.parentChannelId || !channel.parentMessageId) return []
    return [{
      id: channel.id,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      title: openerById.get(channel.parentMessageId)?.content || channel.name,
      activityAt: channel.activityAt,
      expiresAt: channel.expiresAt,
      unread: channel.unread,
    }]
  })
}

export function useForumSidebarThreads(serverId: string, retainId: string | null) {
  const queryClient = useQueryClient()
  // Observe (without fetching) the already-canonical ServerDetail cache so a
  // fresh `/unreads` result re-runs attribution even when the sidebar rows did
  // not change. This is essential for access/archive/participation removal:
  // those must clear a prior fallback instead of being mistaken for expiry.
  const serverDetailQuery = useQuery<ServerDetail>({
    queryKey: communityKeys.server(serverId),
    queryFn: () => Promise.reject(new Error("server detail observer only")),
    enabled: false,
  })
  const query = useQuery({
    queryKey: communityKeys.forumSidebarThreadsView(serverId, retainId),
    enabled: !!serverId,
    // `retainId` is part of the key because the server may return an otherwise
    // expired/non-top-five active thread. Keep the prior projection visible
    // while that neighboring view loads so route changes never collapse the
    // sidebar to an empty list for a frame.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({
        type: "thread",
        parentType: "forum",
        participating: "true",
        activeWithin: "72h",
        limitPerParent: "5",
        include: "parentMessage",
      })
      if (retainId) params.set("retainId", retainId)
      const envelope = await apiFetch<SidebarThreadEnvelope>(
        `/api/community/servers/${serverId}/channels?${params.toString()}`,
      )
      const serverNowMs = Date.parse(envelope.serverNow)
      return {
        ...envelope,
        threads: projectForumSidebarThreads(envelope),
        serverClockOffsetMs: Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : 0,
      } satisfies ForumSidebarQueryData
    },
  })

  useEffect(() => {
    if (!query.data) return
    reconcileForumSidebarUnreadFallbacks(
      queryClient,
      serverId,
      query.data.threads.map((thread) => thread.id),
    )
  }, [query.data, queryClient, serverDetailQuery.data?.forumUnreadState, serverId])

  // Expire rows against the server's clock without polling. The currently
  // retained route is deliberately excluded: it remains visible until the
  // viewer leaves it, even when its ordinary 72h expiry is already past.
  useEffect(() => {
    const data = query.data
    if (!data) return
    const serverNowMs = Date.now() + data.serverClockOffsetMs
    const nextExpiry = data.threads
      .filter((thread) => thread.id !== retainId)
      .map((thread) => Date.parse(thread.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt))
      .sort((a, b) => a - b)[0]
    if (nextExpiry === undefined) return
    const timeout = globalThis.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.forumSidebarThreads(serverId) })
    }, Math.max(0, nextExpiry - serverNowMs) + 25)
    return () => globalThis.clearTimeout(timeout)
  }, [query.data, queryClient, retainId, serverId])

  return {
    ...query,
    threads: query.data?.threads ?? [],
  }
}
