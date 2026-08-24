"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { patchChannelUnread } from "@/hooks/community/server-detail-cache"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { useCommunityWsStore } from "@/stores/community/ws"

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
    serverId?: string
    type?: string
    creatorId?: string | null
    archived?: boolean | number
    lastMessageAt?: string | null
    createdAt?: string
  }>
  canonicalChannels?: SidebarThreadEnvelope["channels"]
  retainedChannel?: SidebarThreadEnvelope["channels"][number] | null
  included: {
    parentMessages: Array<{ id: string; content: string; seq?: number; channelId?: string }>
  }
  serverNow: string
}

export type ForumSidebarQueryData = {
  threads: ForumSidebarThread[]
  verifiedEpoch: number
  serverNow: string
  serverClockOffsetMs: number
}

export type ChildChannelMeta = {
  id: string
  serverId: string
  name: string
  type: string
  parentChannelId: string
  parentMessageId: string
  creatorId: string | null
  archived: boolean
  activityAt: string
  verifiedEpoch: number
}

export type ForumOpenerHint = {
  id: string
  content: string
  seq?: number
  channelId?: string
}

export type NormalizedForumSidebarEnvelope = {
  base: ForumSidebarQueryData
  retained: ForumSidebarThread | null
  channelMetas: Record<string, ChildChannelMeta>
  openerHints: Record<string, ForumOpenerHint>
}

export function resolveForumSidebarRouteCandidate(
  channelId: string | null,
  topLevelChannelIds: Iterable<string> | null,
) {
  if (!channelId || !topLevelChannelIds) return null
  return new Set(topLevelChannelIds).has(channelId) ? null : channelId
}

type InflightDelta = {
  activity: Map<string, { parentChannelId: string; activityAt: string }>
  titles: Map<string, string>
  unread: Map<string, boolean>
  removed: Set<string>
}

type InflightRecord = {
  promise: Promise<NormalizedForumSidebarEnvelope>
  delta: InflightDelta
  candidate: string | null
  controller: AbortController
  signals: Set<AbortSignal>
  abortTimer: ReturnType<typeof setTimeout> | null
}

const inflight = new Map<string, InflightRecord>()

function recordInflightDelta(
  serverId: string,
  update: (delta: InflightDelta) => void,
) {
  const record = inflight.get(serverId)
  if (record) update(record.delta)
}

export type ForumSidebarUnreadFallbackState = Record<string, {
  baseUnread: boolean
  childIds: string[]
}>

const SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000
const STRICT_MODE_ABORT_GRACE_MS = 50

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

function patchForumSidebarTitle(
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

function projectChannels(
  channels: SidebarThreadEnvelope["channels"],
  parentMessages: SidebarThreadEnvelope["included"]["parentMessages"],
): ForumSidebarThread[] {
  return projectForumSidebarThreads({
    channels,
    included: { parentMessages },
    serverNow: "",
  })
}

function childMeta(
  channel: SidebarThreadEnvelope["channels"][number],
): ChildChannelMeta | null {
  if (
    !channel.serverId || !channel.type || !channel.parentChannelId ||
    !channel.parentMessageId
  ) return null
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    type: channel.type,
    parentChannelId: channel.parentChannelId,
    parentMessageId: channel.parentMessageId,
    creatorId: channel.creatorId ?? null,
    archived: channel.archived === true || channel.archived === 1,
    activityAt: channel.activityAt,
    verifiedEpoch: -1,
  }
}

export function normalizeForumSidebarEnvelope(
  envelope: SidebarThreadEnvelope,
  retainId: string | null,
  serverClockOffsetOverride?: number,
): NormalizedForumSidebarEnvelope {
  const canonicalChannels = envelope.canonicalChannels ?? envelope.channels
  const threads = projectChannels(canonicalChannels, envelope.included.parentMessages)
  const serverNowMs = Date.parse(envelope.serverNow)
  const base: ForumSidebarQueryData = {
    threads,
    serverNow: envelope.serverNow,
    verifiedEpoch: -1,
    serverClockOffsetMs: serverClockOffsetOverride ??
      (Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : 0),
  }
  const retainedChannel = retainId && envelope.retainedChannel?.id === retainId
    ? envelope.retainedChannel
    : null
  const retained = retainedChannel
    ? projectChannels([retainedChannel], envelope.included.parentMessages)[0] ?? null
    : null
  const channelMetas: Record<string, ChildChannelMeta> = {}
  for (const channel of retainedChannel
    ? [...canonicalChannels, retainedChannel]
    : canonicalChannels) {
    const meta = childMeta(channel)
    if (meta) channelMetas[meta.id] = meta
  }
  const openerHints = Object.fromEntries(
    envelope.included.parentMessages.map(({ id, content, seq, channelId }) => [
      id,
      { id, content, ...(seq === undefined ? {} : { seq }), ...(channelId ? { channelId } : {}) },
    ]),
  )
  return { base, retained, channelMetas, openerHints }
}

export function deriveForumSidebarProjection(
  base: ForumSidebarQueryData | undefined,
  activeExtra: ForumSidebarThread | null | undefined,
  ownership: ServerDetail["forumUnreadState"] | undefined,
  nowMs = Date.now(),
  limitPerParent = 5,
) {
  if (!base) return { threads: [] as ForumSidebarThread[], parentUnread: {} as Record<string, boolean> }
  const serverNowMs = nowMs + base.serverClockOffsetMs
  let threads = base.threads.filter((thread) => {
    const expiresAt = Date.parse(thread.expiresAt)
    return !Number.isFinite(expiresAt) || expiresAt > serverNowMs
  })
  if (activeExtra && !threads.some((thread) => thread.id === activeExtra.id)) {
    const siblings = threads.filter((thread) => thread.parentChannelId === activeExtra.parentChannelId)
    const otherParents = threads.filter((thread) => thread.parentChannelId !== activeExtra.parentChannelId)
    threads = [...otherParents, ...siblings.slice(0, Math.max(0, limitPerParent - 1)), activeExtra]
      .sort((a, b) => {
        if (a.parentChannelId !== b.parentChannelId) return a.parentChannelId < b.parentChannelId ? -1 : 1
        if (a.activityAt !== b.activityAt) return a.activityAt > b.activityAt ? -1 : 1
        return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
      })
  }
  const renderedIds = new Set(threads.map((thread) => thread.id))
  threads = threads.map((thread) => ({
    ...thread,
    unread: ownership?.[thread.parentChannelId]?.childIds.includes(thread.id) ?? thread.unread,
  }))
  const parentUnread: Record<string, boolean> = {}
  for (const [parentId, state] of Object.entries(ownership ?? {})) {
    parentUnread[parentId] = state.baseUnread || state.childIds.some((id) => !renderedIds.has(id))
  }
  return { threads, parentUnread }
}

export function getForumSidebarBase(queryClient: QueryClient, serverId: string) {
  return queryClient.getQueryData<ForumSidebarQueryData>(
    communityKeys.forumSidebarThreads(serverId),
  )
}

function getForumSidebarRetained(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  return queryClient.getQueryData<ForumSidebarThread | null>(
    communityKeys.forumSidebarRetained(serverId, childId),
  )
}

export function hasProjectedForumSidebarThread(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  activeChildId: string | null | undefined,
) {
  const access = useCommunityWsStore.getState()
  const base = getForumSidebarBase(queryClient, serverId)
  if (
    !access.accessConnected ||
    !base ||
    base.verifiedEpoch !== access.accessEpoch
  ) return false
  const activeExtra = activeChildId
    ? getForumSidebarRetained(queryClient, serverId, activeChildId)
    : null
  const ownership = queryClient.getQueryData<ServerDetail>(
    communityKeys.server(serverId),
  )?.forumUnreadState
  return deriveForumSidebarProjection(base, activeExtra, ownership)
    .threads.some((thread) => thread.id === childId)
}

export function isKnownNonForumSidebarChannel(
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  const server = queryClient.getQueryData<ServerDetail>(communityKeys.server(serverId))
  const topLevel = server?.categories
    .flatMap((category) => category.channels)
    .find((channel) => channel.id === channelId)
  if (topLevel) return topLevel.type !== "forum"
  const meta = queryClient.getQueryData<ChildChannelMeta>(
    communityKeys.channelMeta(serverId, channelId),
  )
  if (!meta) return false
  const parent = server?.categories
    .flatMap((category) => category.channels)
    .find((channel) => channel.id === meta.parentChannelId)
  return !!parent && parent.type !== "forum"
}

export function isForumSidebarParent(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
) {
  return queryClient.getQueryData<ServerDetail>(communityKeys.server(serverId))
    ?.categories.some((category) => category.channels.some(
      (channel) => channel.id === parentChannelId && channel.type === "forum",
    )) ?? false
}

export function hasForumSidebarOwnershipEvidence(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  if (isKnownNonForumSidebarChannel(queryClient, serverId, childId)) return false
  if (hasForumSidebarThread(getForumSidebarBase(queryClient, serverId), childId)) return true
  if (getForumSidebarRetained(queryClient, serverId, childId)) return true
  const server = queryClient.getQueryData<ServerDetail>(communityKeys.server(serverId))
  if (Object.values(server?.forumUnreadState ?? {}).some(
    (state) => state.childIds.includes(childId),
  )) return true
  const meta = queryClient.getQueryData<ChildChannelMeta>(
    communityKeys.channelMeta(serverId, childId),
  )
  return !!meta && isForumSidebarParent(queryClient, serverId, meta.parentChannelId)
}

function patchRetained(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  patch: (thread: ForumSidebarThread) => ForumSidebarThread,
) {
  queryClient.setQueryData<ForumSidebarThread | null | undefined>(
    communityKeys.forumSidebarRetained(serverId, childId),
    (thread) => thread ? patch(thread) : thread,
  )
}

export function patchForumSidebarActivityExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  parentChannelId: string,
  activityAt: string,
) {
  recordInflightDelta(serverId, (delta) => {
    delta.activity.set(childId, { parentChannelId, activityAt })
  })
  queryClient.setQueryData<ForumSidebarQueryData | undefined>(
    communityKeys.forumSidebarThreads(serverId),
    (data) => patchForumSidebarActivity(data, childId, parentChannelId, activityAt),
  )
  patchRetained(queryClient, serverId, childId, (thread) => ({
    ...thread,
    activityAt,
    expiresAt: new Date(Date.parse(activityAt) + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString(),
  }))
  queryClient.setQueryData<ChildChannelMeta | undefined>(
    communityKeys.channelMeta(serverId, childId),
    (meta) => meta ? { ...meta, activityAt } : meta,
  )
}

export function patchForumSidebarTitleExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  title: string,
) {
  recordInflightDelta(serverId, (delta) => {
    delta.titles.set(childId, title)
  })
  queryClient.setQueryData<ForumSidebarQueryData | undefined>(
    communityKeys.forumSidebarThreads(serverId),
    (data) => patchForumSidebarTitle(data, childId, title),
  )
  patchRetained(queryClient, serverId, childId, (thread) => ({ ...thread, title }))
  const meta = queryClient.getQueryData<ChildChannelMeta>(communityKeys.channelMeta(serverId, childId))
  if (meta) {
    queryClient.setQueryData<ForumOpenerHint | undefined>(
      communityKeys.forumOpenerHint(serverId, meta.parentMessageId),
      (hint) => hint ? { ...hint, content: title } : hint,
    )
  }
}

export function patchForumSidebarUnreadExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  unread: boolean,
) {
  recordInflightDelta(serverId, (delta) => {
    delta.unread.set(childId, unread)
  })
  queryClient.setQueryData<ForumSidebarQueryData | undefined>(
    communityKeys.forumSidebarThreads(serverId),
    (data) => patchForumSidebarUnread(data, childId, unread),
  )
  patchRetained(queryClient, serverId, childId, (thread) => ({ ...thread, unread }))
}

export function removeForumSidebarThreadExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  const meta = queryClient.getQueryData<ChildChannelMeta>(
    communityKeys.channelMeta(serverId, childId),
  )
  const parentMessageId = meta?.parentMessageId ??
    getForumSidebarRetained(queryClient, serverId, childId)?.parentMessageId ??
    getForumSidebarBase(queryClient, serverId)?.threads
      .find((thread) => thread.id === childId)?.parentMessageId
  recordInflightDelta(serverId, (delta) => {
    delta.removed.add(childId)
  })
  queryClient.setQueryData<ForumSidebarQueryData | undefined>(
    communityKeys.forumSidebarThreads(serverId),
    (data) => removeForumSidebarThread(data, childId),
  )
  queryClient.removeQueries({
    queryKey: communityKeys.forumSidebarRetained(serverId, childId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: communityKeys.channelMeta(serverId, childId),
    exact: true,
  })
  if (parentMessageId) {
    queryClient.removeQueries({
      queryKey: communityKeys.forumOpenerHint(serverId, parentMessageId),
      exact: true,
    })
  }
}

/** Undo only the in-flight removal tombstone after an optimistic HTTP failure. */
export function restoreForumSidebarThreadInflight(
  serverId: string,
  childId: string,
) {
  recordInflightDelta(serverId, (delta) => {
    delta.removed.delete(childId)
  })
}

export function removeForumSidebarChildrenForParent(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
) {
  const childIds = new Set(
    getForumSidebarBase(queryClient, serverId)?.threads
      .filter((thread) => thread.parentChannelId === parentChannelId)
      .map((thread) => thread.id) ?? [],
  )
  for (const [, meta] of queryClient.getQueriesData<ChildChannelMeta>({
    queryKey: communityKeys.channelMetaRoot(serverId),
  })) {
    if (meta?.parentChannelId === parentChannelId) childIds.add(meta.id)
  }
  for (const [, thread] of queryClient.getQueriesData<ForumSidebarThread | null>({
    queryKey: communityKeys.forumSidebarRetainedRoot(serverId),
  })) {
    if (thread?.parentChannelId === parentChannelId) childIds.add(thread.id)
  }
  for (const childId of childIds) {
    removeForumSidebarUnreadChild(queryClient, serverId, childId)
    removeForumSidebarThreadExact(queryClient, serverId, childId)
  }
}

export async function invalidateForumSidebarBaseExact(queryClient: QueryClient, serverId: string) {
  const pending = inflight.get(serverId)
  if (pending) {
    if (pending.abortTimer !== null) globalThis.clearTimeout(pending.abortTimer)
    pending.controller.abort()
    inflight.delete(serverId)
  }
  const queryKey = communityKeys.forumSidebarThreads(serverId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  await queryClient.invalidateQueries({
    queryKey,
    exact: true,
    refetchType: "active",
  })
}

export function grantForumSidebarChild(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  recordInflightDelta(serverId, (delta) => {
    delta.removed.delete(childId)
  })
  void queryClient.cancelQueries({
    queryKey: communityKeys.forumSidebarRetained(serverId, childId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: communityKeys.forumSidebarRetained(serverId, childId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: communityKeys.channelMeta(serverId, childId),
    exact: true,
  })
  return invalidateForumSidebarBaseExact(queryClient, serverId)
}

function sidebarUrl(serverId: string, retainId: string | null) {
  const params = new URLSearchParams({
    type: "thread",
    parentType: "forum",
    participating: "true",
    activeWithin: "72h",
    limitPerParent: "5",
    include: "parentMessage",
  })
  if (retainId) params.set("retainId", retainId)
  return `/api/community/servers/${serverId}/channels?${params.toString()}`
}

function attachInflightSignal(
  serverId: string,
  record: InflightRecord,
  signal?: AbortSignal,
) {
  if (!signal || record.signals.has(signal)) return
  if (record.abortTimer !== null) {
    globalThis.clearTimeout(record.abortTimer)
    record.abortTimer = null
  }
  record.signals.add(signal)
  const release = () => {
    record.signals.delete(signal)
    if (record.signals.size > 0 || record.abortTimer !== null) return
    record.abortTimer = globalThis.setTimeout(() => {
      record.abortTimer = null
      if (inflight.get(serverId) === record && record.signals.size === 0) {
        record.controller.abort()
      }
    }, STRICT_MODE_ABORT_GRACE_MS)
  }
  if (signal.aborted) release()
  else signal.addEventListener("abort", release, { once: true })
}

function fetchForumSidebar(serverId: string, retainId: string | null, signal?: AbortSignal) {
  const pending = inflight.get(serverId)
  if (pending?.candidate === retainId && !pending.controller.signal.aborted) {
    attachInflightSignal(serverId, pending, signal)
    return pending.promise
  }
  if (pending) {
    if (pending.abortTimer !== null) globalThis.clearTimeout(pending.abortTimer)
    pending.controller.abort()
    inflight.delete(serverId)
  }
  const controller = new AbortController()
  const delta: InflightDelta = {
    activity: new Map(),
    titles: new Map(),
    unread: new Map(),
    removed: new Set(),
  }
  const request = apiFetch<SidebarThreadEnvelope>(sidebarUrl(serverId, retainId), {
    signal: controller.signal,
  })
    .then((envelope) => normalizeForumSidebarEnvelope(envelope, retainId))
    .then((normalized) => {
      let base: ForumSidebarQueryData | undefined = normalized.base
      let retained = normalized.retained
      const channelMetas = { ...normalized.channelMetas }
      const openerHints = { ...normalized.openerHints }
      for (const [childId, update] of delta.activity) {
        base = patchForumSidebarActivity(
          base,
          childId,
          update.parentChannelId,
          update.activityAt,
        )
        if (retained?.id === childId) {
          retained = {
            ...retained,
            activityAt: update.activityAt,
            expiresAt: new Date(
              Date.parse(update.activityAt) + SIDEBAR_ACTIVITY_WINDOW_MS,
            ).toISOString(),
          }
        }
        if (channelMetas[childId]) {
          channelMetas[childId] = {
            ...channelMetas[childId],
            activityAt: update.activityAt,
          }
        }
      }
      for (const [childId, title] of delta.titles) {
        base = patchForumSidebarTitle(base, childId, title)
        if (retained?.id === childId) retained = { ...retained, title }
        const meta = channelMetas[childId]
        if (meta && openerHints[meta.parentMessageId]) {
          openerHints[meta.parentMessageId] = {
            ...openerHints[meta.parentMessageId],
            content: title,
          }
        }
      }
      for (const [childId, unread] of delta.unread) {
        base = patchForumSidebarUnread(base, childId, unread)
        if (retained?.id === childId) retained = { ...retained, unread }
      }
      for (const childId of delta.removed) {
        const meta = channelMetas[childId]
        if (meta) delete openerHints[meta.parentMessageId]
        delete channelMetas[childId]
        base = removeForumSidebarThread(base, childId)
        if (retained?.id === childId) retained = null
      }
      return {
        ...normalized,
        base: base ?? normalized.base,
        retained,
        channelMetas,
        openerHints,
      }
    })
    .finally(() => {
      const current = inflight.get(serverId)
      if (current?.promise !== request) return
      if (current.abortTimer !== null) globalThis.clearTimeout(current.abortTimer)
      inflight.delete(serverId)
    })
  const record: InflightRecord = {
    promise: request,
    delta,
    candidate: retainId,
    controller,
    signals: new Set(),
    abortTimer: null,
  }
  inflight.set(serverId, record)
  attachInflightSignal(serverId, record, signal)
  return request
}

function seedForumSidebarResources(
  queryClient: QueryClient,
  serverId: string,
  normalized: NormalizedForumSidebarEnvelope,
  verifiedEpoch: number,
  retainId: string | null,
) {
  if (
    retainId &&
    !normalized.retained &&
    !hasForumSidebarThread(normalized.base, retainId) &&
    hasForumSidebarOwnershipEvidence(queryClient, serverId, retainId)
  ) {
    removeForumSidebarUnreadChild(queryClient, serverId, retainId)
    removeForumSidebarThreadExact(queryClient, serverId, retainId)
  }
  for (const meta of Object.values(normalized.channelMetas)) {
    queryClient.setQueryData(
      communityKeys.channelMeta(serverId, meta.id),
      { ...meta, verifiedEpoch },
    )
  }
  for (const hint of Object.values(normalized.openerHints)) {
    queryClient.setQueryData(communityKeys.forumOpenerHint(serverId, hint.id), hint)
  }
}

function throwIfConsumerAborted(signal: AbortSignal) {
  if (!signal.aborted) return
  const error = new Error("Aborted")
  error.name = "AbortError"
  throw error
}

export function useForumSidebarThreads(
  serverId: string,
  retainId: string | null,
  enabled = true,
) {
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const previousRetainId = useRef(retainId)
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
    queryKey: communityKeys.forumSidebarThreads(serverId),
    enabled: !!serverId && enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const requestEpoch = useCommunityWsStore.getState().accessEpoch
      const normalized = await fetchForumSidebar(serverId, retainId, signal)
      throwIfConsumerAborted(signal)
      seedForumSidebarResources(queryClient, serverId, normalized, requestEpoch, retainId)
      if (retainId) {
        queryClient.setQueryData(
          communityKeys.forumSidebarRetained(serverId, retainId),
          normalized.retained,
        )
      }
      return { ...normalized.base, verifiedEpoch: requestEpoch }
    },
  })
  useEffect(() => {
    if (previousRetainId.current === retainId) return
    previousRetainId.current = retainId
    if (query.fetchStatus !== "fetching") return
    if (inflight.get(serverId)?.candidate === retainId) return
    void queryClient.cancelQueries({
      queryKey: communityKeys.forumSidebarThreads(serverId),
      exact: true,
    }).then(() => invalidateForumSidebarBaseExact(queryClient, serverId))
  }, [query.fetchStatus, queryClient, retainId, serverId])
  useEffect(() => {
    if (!retainId) return
    const canonical = query.data?.threads.find((thread) => thread.id === retainId)
    if (!canonical) return
    const key = communityKeys.forumSidebarRetained(serverId, retainId)
    if (queryClient.getQueryState(key)?.status === "success") return
    queryClient.setQueryData(key, canonical)
  }, [query.data, queryClient, retainId, serverId])
  const retainedKey = communityKeys.forumSidebarRetained(serverId, retainId ?? "__none__")
  const retainedState = queryClient.getQueryState<ForumSidebarThread | null>(retainedKey)
  const retainIsCanonical = !!retainId && hasForumSidebarThread(query.data, retainId)
  const retainedQuery = useQuery<ForumSidebarThread | null>({
    queryKey: retainedKey,
    enabled: enabled && !!retainId && query.isSuccess && query.fetchStatus === "idle" &&
      !retainIsCanonical && retainedState?.status !== "success",
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const requestEpoch = useCommunityWsStore.getState().accessEpoch
      const normalized = await fetchForumSidebar(serverId, retainId, signal)
      throwIfConsumerAborted(signal)
      seedForumSidebarResources(queryClient, serverId, normalized, requestEpoch, retainId)
      queryClient.setQueryData(
        communityKeys.forumSidebarThreads(serverId),
        { ...normalized.base, verifiedEpoch: requestEpoch },
      )
      return normalized.retained
    },
  })
  const [trustedBase, setTrustedBase] = useState<{
    serverId: string
    data: ForumSidebarQueryData
  } | null>(null)
  useEffect(() => {
    if (query.data?.verifiedEpoch !== accessEpoch) return
    setTrustedBase({ serverId, data: query.data })
  }, [accessEpoch, query.data, serverId])
  const renderableBase = query.data?.verifiedEpoch === accessEpoch
    ? query.data
    : trustedBase?.serverId === serverId ? trustedBase.data : undefined
  const projection = useMemo(() => deriveForumSidebarProjection(
    renderableBase,
    renderableBase ? retainedQuery.data : null,
    serverDetailQuery.data?.forumUnreadState,
  ), [renderableBase, retainedQuery.data, serverDetailQuery.data?.forumUnreadState])

  useEffect(() => {
    if (!query.data) return
    reconcileForumSidebarUnreadFallbacks(
      queryClient,
      serverId,
      projection.threads.map((thread) => thread.id),
    )
  }, [projection.threads, query.data, queryClient, serverDetailQuery.data?.forumUnreadState, serverId])

  // Expire rows against the server's clock without polling. The currently
  // retained route is deliberately excluded: it remains visible until the
  // viewer leaves it, even when its ordinary 72h expiry is already past.
  useEffect(() => {
    const data = query.data
    if (!data) return
    const serverNowMs = Date.now() + data.serverClockOffsetMs
    const nextExpiry = data.threads
      .map((thread) => Date.parse(thread.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt))
      .sort((a, b) => a - b)[0]
    if (nextExpiry === undefined) return
    const timeout = globalThis.setTimeout(() => {
      const current = getForumSidebarBase(queryClient, serverId)
      const currentServerNow = Date.now() + (current?.serverClockOffsetMs ?? 0)
      for (const thread of current?.threads ?? []) {
        if (Date.parse(thread.expiresAt) > currentServerNow) continue
        if (thread.id === retainId) {
          queryClient.setQueryData<ForumSidebarQueryData | undefined>(
            communityKeys.forumSidebarThreads(serverId),
            (value) => removeForumSidebarThread(value, thread.id),
          )
        } else {
          removeForumSidebarThreadExact(queryClient, serverId, thread.id)
        }
      }
      void invalidateForumSidebarBaseExact(queryClient, serverId)
    }, Math.max(0, nextExpiry - serverNowMs) + 25)
    return () => globalThis.clearTimeout(timeout)
  }, [query.data, queryClient, retainId, serverId])

  return {
    ...query,
    threads: projection.threads,
    parentUnread: projection.parentUnread,
  }
}
