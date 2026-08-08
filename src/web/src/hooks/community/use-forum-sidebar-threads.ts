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

/**
 * Attribute a parent-row fallback dot to the missing child that caused it.
 * `baseUnread` snapshots the parent's own unread state so later migration to a
 * loaded child removes only the fallback contribution, never a genuine parent
 * unread.
 */
export function recordForumSidebarUnreadFallback(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
  childChannelId: string,
) {
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  const serverKey = communityKeys.server(serverId)
  const baseUnread = parentUnread(
    queryClient.getQueryData<ServerDetail>(serverKey),
    parentChannelId,
  )
  queryClient.setQueryData<ForumSidebarUnreadFallbackState>(key, (state = {}) => {
    const current = state[parentChannelId]
    if (current?.childIds.includes(childChannelId)) return state
    return {
      ...state,
      [parentChannelId]: {
        baseUnread: current?.baseUnread ?? baseUnread,
        childIds: [...(current?.childIds ?? []), childChannelId],
      },
    }
  })
  queryClient.setQueryData<ServerDetail | undefined>(serverKey, (cache) =>
    patchChannelUnread(cache, parentChannelId, true),
  )
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
  if (!current) return false
  queryClient.setQueryData<ForumSidebarUnreadFallbackState>(key, {
    ...state,
    [parentChannelId]: { ...current, baseUnread: unread },
  })
  queryClient.setQueryData<ServerDetail | undefined>(
    communityKeys.server(serverId),
    (cache) => patchChannelUnread(cache, parentChannelId, unread || current.childIds.length > 0),
  )
  return true
}

/** Move fallback ownership from a parent row to children that became locatable. */
export function reconcileForumSidebarUnreadFallbacks(
  queryClient: QueryClient,
  serverId: string,
  loadedChildIds: Iterable<string>,
) {
  const loaded = new Set(loadedChildIds)
  if (loaded.size === 0) return
  const key = communityKeys.forumSidebarUnreadFallbacks(serverId)
  const state = queryClient.getQueryData<ForumSidebarUnreadFallbackState>(key)
  if (!state) return

  let nextState = state
  let nextServer = queryClient.getQueryData<ServerDetail>(communityKeys.server(serverId))
  for (const [parentChannelId, entry] of Object.entries(state)) {
    const childIds = entry.childIds.filter((id) => !loaded.has(id))
    if (childIds.length === entry.childIds.length) continue
    if (nextState === state) nextState = { ...state }
    if (childIds.length === 0) delete nextState[parentChannelId]
    else nextState[parentChannelId] = { ...entry, childIds }
    nextServer = patchChannelUnread(
      nextServer,
      parentChannelId,
      entry.baseUnread || childIds.length > 0,
    )
  }

  if (nextState !== state) {
    queryClient.setQueryData(key, nextState)
    queryClient.setQueryData(communityKeys.server(serverId), nextServer)
  }
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
  }, [query.data, queryClient, serverId])

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
