"use client"

import { useEffect } from "react"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

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
}

const SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000

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
      return { ...envelope, threads: projectForumSidebarThreads(envelope) } satisfies ForumSidebarQueryData
    },
  })

  // Expire rows against the server's clock without polling. The currently
  // retained route is deliberately excluded: it remains visible until the
  // viewer leaves it, even when its ordinary 72h expiry is already past.
  useEffect(() => {
    const data = query.data
    if (!data) return
    const serverNowMs = Date.parse(data.serverNow)
    const nextExpiry = data.threads
      .filter((thread) => thread.id !== retainId)
      .map((thread) => Date.parse(thread.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt))
      .sort((a, b) => a - b)[0]
    if (nextExpiry === undefined || !Number.isFinite(serverNowMs)) return
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
