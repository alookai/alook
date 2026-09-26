"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { compareAsciiSqliteBinary } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  useForumSidebarProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  captureCommunityLiveSnapshotToken,
  getCanonicalCommunityChannelMemberships,
  getCanonicalCommunityChannels,
  getCanonicalCommunityMessages,
  patchCanonicalCommunityChannel,
  patchCanonicalCommunityMessage,
  publishCommunityForumSidebar,
  removeCanonicalCommunityChannelMembership,
  removeCanonicalCommunityChannel,
  setCanonicalCommunityChannelMembership,
} from "@/lib/community-db/sync"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"

export type ForumSidebarThread = {
  id: string
  parentChannelId: string
  parentMessageId: string
  title: string
  activityAt: string
  expiresAt: string
  unread: boolean
}

type ForumSidebarRetainedDisposition =
  | "eligible"
  | "opener-archived"
  | "genuine-negative"

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
  retainedDisposition?: ForumSidebarRetainedDisposition | null
  included: {
    parentMessages: Array<{
      id: string
      content: string
      seq?: number
      channelId?: string
      type?: string
    }>
  }
  serverNow: string
}

export type ForumSidebarQueryData = {
  /** Empty with a DB registry; only the explicit providerless test boundary uses rows. */
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
  type?: "chat" | "system"
}

export type NormalizedForumSidebarEnvelope = {
  base: ForumSidebarQueryData
  retained: ForumSidebarThread | null
  retainedDisposition: ForumSidebarRetainedDisposition | null
  channelMetas: Record<string, ChildChannelMeta>
  openerHints: Record<string, ForumOpenerHint>
}

/** Source-compatible shape only; no unread fallback cache is stored. */
export type ForumSidebarUnreadFallbackState = Record<string, {
  baseUnread: boolean
  childIds: string[]
}>

type InflightDelta = {
  activity: Map<string, { parentChannelId: string; activityAt: string }>
  titles: Map<string, string>
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

const SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000
const STRICT_MODE_ABORT_GRACE_MS = 50
const inflight = new Map<string, InflightRecord>()

export function resolveForumSidebarRouteCandidate(
  channelId: string | null,
  topLevelChannelIds: Iterable<string> | null,
  parentIsForum: boolean | null | undefined,
) {
  if (!channelId || !topLevelChannelIds || !parentIsForum) return null
  return new Set(topLevelChannelIds).has(channelId) ? null : channelId
}

export function hasForumSidebarThread(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
) {
  return !!data?.threads.some((thread) => thread.id === threadId)
}

function compareThreads(left: ForumSidebarThread, right: ForumSidebarThread) {
  return compareAsciiSqliteBinary(left.parentChannelId, right.parentChannelId)
    || compareAsciiSqliteBinary(right.activityAt, left.activityAt)
    || compareAsciiSqliteBinary(right.id, left.id)
}

function patchForumSidebarActivity(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
  parentChannelId: string,
  activityAt: string,
): ForumSidebarQueryData | undefined {
  if (!data || !data.threads.some((thread) => (
    thread.id === threadId && thread.parentChannelId === parentChannelId
  ))) return data
  const expiresAt = new Date(Date.parse(activityAt) + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
  return {
    ...data,
    threads: data.threads
      .map((thread) => thread.id === threadId
        ? { ...thread, activityAt, expiresAt }
        : thread)
      .sort(compareThreads),
  }
}

function patchForumSidebarTitle(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
  title: string,
) {
  if (!data) return data
  return {
    ...data,
    threads: data.threads.map((thread) => (
      thread.id === threadId ? { ...thread, title } : thread
    )),
  }
}

function removeForumSidebarThread(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
) {
  return data
    ? { ...data, threads: data.threads.filter((thread) => thread.id !== threadId) }
    : data
}

function projectForumSidebarThreads(data: SidebarThreadEnvelope) {
  const openerById = new Map(data.included.parentMessages.map((message) => [message.id, message]))
  return data.channels.flatMap((channel): ForumSidebarThread[] => {
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

function childMeta(
  channel: SidebarThreadEnvelope["channels"][number],
): ChildChannelMeta | null {
  if (!channel.serverId || !channel.type || !channel.parentChannelId || !channel.parentMessageId) {
    return null
  }
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
  const base: ForumSidebarQueryData = {
    threads: projectForumSidebarThreads({ ...envelope, channels: canonicalChannels }),
    serverNow: envelope.serverNow,
    verifiedEpoch: -1,
    serverClockOffsetMs: serverClockOffsetOverride ?? (() => {
      const serverNowMs = Date.parse(envelope.serverNow)
      return Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : 0
    })(),
  }
  const retainedChannel = retainId && envelope.retainedChannel?.id === retainId
    ? envelope.retainedChannel
    : null
  const retained = retainedChannel
    ? projectForumSidebarThreads({ ...envelope, channels: [retainedChannel] })[0] ?? null
    : null
  const retainedDisposition = retainId
    ? envelope.retainedDisposition ?? (retained ? "eligible" : "genuine-negative")
    : null
  const channelMetas: Record<string, ChildChannelMeta> = {}
  for (const channel of retainedChannel
    ? [...canonicalChannels, retainedChannel]
    : canonicalChannels) {
    const meta = childMeta(channel)
    if (meta) channelMetas[meta.id] = meta
  }
  const openerHints = Object.fromEntries(
    envelope.included.parentMessages.map((message) => [message.id, {
      ...message,
      type: message.type === "system" ? "system" : "chat",
    } satisfies ForumOpenerHint]),
  )
  return { base, retained, retainedDisposition, channelMetas, openerHints }
}

export function deriveForumSidebarProjection(
  base: ForumSidebarQueryData | undefined,
  activeExtra: ForumSidebarThread | null | undefined,
  ownership: ForumSidebarUnreadFallbackState | undefined,
  nowMs = Date.now(),
  limitPerParent = 5,
) {
  if (!base) {
    return { threads: [] as ForumSidebarThread[], parentUnread: {} as Record<string, boolean> }
  }
  const serverNowMs = nowMs + base.serverClockOffsetMs
  let threads = base.threads.filter((thread) => {
    const expiry = Date.parse(thread.expiresAt)
    return !Number.isFinite(expiry) || expiry > serverNowMs
  })
  if (activeExtra && !threads.some((thread) => thread.id === activeExtra.id)) {
    threads = [
      ...threads.filter((thread) => thread.parentChannelId !== activeExtra.parentChannelId),
      ...threads
        .filter((thread) => thread.parentChannelId === activeExtra.parentChannelId)
        .slice(0, Math.max(0, limitPerParent - 1)),
      activeExtra,
    ].sort(compareThreads)
  }
  const rendered = new Set(threads.map((thread) => thread.id))
  threads = threads.map((thread) => ({
    ...thread,
    unread: ownership?.[thread.parentChannelId]?.childIds.includes(thread.id)
      ?? thread.unread,
  }))
  const parentUnread: Record<string, boolean> = {}
  for (const [parentId, state] of Object.entries(ownership ?? {})) {
    parentUnread[parentId] = state.baseUnread
      || state.childIds.some((childId) => !rendered.has(childId))
  }
  return { threads, parentUnread }
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
  if (record.abortTimer !== null) globalThis.clearTimeout(record.abortTimer)
  record.abortTimer = null
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

function fetchForumSidebar(
  serverId: string,
  retainId: string | null,
  signal?: AbortSignal,
) {
  const pending = inflight.get(serverId)
  if (pending?.candidate === retainId && !pending.controller.signal.aborted) {
    attachInflightSignal(serverId, pending, signal)
    return pending.promise
  }
  if (pending) pending.controller.abort()
  const controller = new AbortController()
  const delta: InflightDelta = {
    activity: new Map(),
    titles: new Map(),
    removed: new Set(),
  }
  const request = apiFetch<SidebarThreadEnvelope>(sidebarUrl(serverId, retainId), {
    signal: controller.signal,
  }).then((envelope) => normalizeForumSidebarEnvelope(envelope, retainId))
    .then((normalized) => {
      let base: ForumSidebarQueryData | undefined = normalized.base
      let retained = normalized.retained
      const channelMetas = { ...normalized.channelMetas }
      const openerHints = { ...normalized.openerHints }
      for (const [childId, update] of delta.activity) {
        base = patchForumSidebarActivity(base, childId, update.parentChannelId, update.activityAt)
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
          channelMetas[childId] = { ...channelMetas[childId], activityAt: update.activityAt }
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
      for (const childId of delta.removed) {
        const meta = channelMetas[childId]
        if (meta) delete openerHints[meta.parentMessageId]
        delete channelMetas[childId]
        base = removeForumSidebarThread(base, childId)
        if (retained?.id === childId) retained = null
      }
      return { ...normalized, base: base!, retained, channelMetas, openerHints }
    }).finally(() => {
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

function recordInflightDelta(serverId: string, update: (delta: InflightDelta) => void) {
  const record = inflight.get(serverId)
  if (record) update(record.delta)
}

function publishNormalizedForumSidebar(
  queryClient: QueryClient,
  serverId: string,
  normalized: NormalizedForumSidebarEnvelope,
  retainId: string | null,
  signal: AbortSignal | undefined,
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>,
) {
  const threads = [
    ...normalized.base.threads,
    ...(normalized.retainedDisposition === "eligible" && normalized.retained
      ? [normalized.retained]
      : []),
  ]
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const participatingIds = new Set(normalized.base.threads.map((thread) => thread.id))
  if (normalized.retainedDisposition === "eligible" && normalized.retained) {
    participatingIds.add(normalized.retained.id)
  }
  publishCommunityForumSidebar(queryClient, {
    serverId,
    channels: Object.values(normalized.channelMetas).flatMap((meta) => {
      const thread = byId.get(meta.id)
      return thread ? [{
        id: meta.id,
        name: meta.name,
        parentChannelId: meta.parentChannelId,
        parentMessageId: meta.parentMessageId,
        activityAt: thread.activityAt,
        unread: thread.unread,
        serverId: meta.serverId,
        type: meta.type,
        creatorId: meta.creatorId,
        archived: meta.archived,
        lastMessageAt: thread.activityAt,
        participating: participatingIds.has(meta.id),
      }] : []
    }),
    openers: Object.values(normalized.openerHints),
    negativeRetain: retainId && normalized.retainedDisposition !== "eligible"
      ? {
          id: retainId,
          disposition: normalized.retainedDisposition ?? "genuine-negative",
        }
      : null,
    proof: { token, signal },
  })
}

function canonicalSidebarBase(queryClient: QueryClient, serverId: string) {
  const participating = new Set(
    getCanonicalCommunityChannelMemberships(queryClient)
      .filter((membership) => membership.relation === "notify")
      .map((membership) => membership.channelId),
  )
  const messages = new Map(
    getCanonicalCommunityMessages(queryClient).map((message) => [message.id, message]),
  )
  const transport = queryClient.getQueryData<ForumSidebarQueryData>(
    communityKeys.forumSidebarThreads(serverId),
  )
  return {
    threads: getCanonicalCommunityChannels(queryClient)
      .filter((channel) => (
        channel.serverId === serverId
        && channel.type === "thread"
        && !channel.archived
        && participating.has(channel.id)
        && channel.parentChannelId
        && channel.parentMessageId
      ))
      .map((channel) => {
        const activityAt = channel.lastMessageAt ?? ""
        const activityMs = Date.parse(activityAt)
        return {
          id: channel.id,
          parentChannelId: channel.parentChannelId!,
          parentMessageId: channel.parentMessageId!,
          title: messages.get(channel.parentMessageId!)?.content ?? channel.name,
          activityAt,
          expiresAt: Number.isFinite(activityMs)
            ? new Date(activityMs + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
            : activityAt,
          unread: channel.unread,
        }
      })
      .sort(compareThreads),
    verifiedEpoch: useCommunityWsStore.getState().accessEpoch,
    serverNow: transport?.serverNow ?? new Date().toISOString(),
    serverClockOffsetMs: transport?.serverClockOffsetMs ?? 0,
  } satisfies ForumSidebarQueryData
}

export function getForumSidebarBase(queryClient: QueryClient, serverId: string) {
  return canonicalSidebarBase(queryClient, serverId)
}

export function isKnownNonForumSidebarChannel(
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  const channels = getCanonicalCommunityChannels(queryClient)
  const channel = channels.find((candidate) => candidate.id === channelId)
  if (!channel) return false
  if (channel.serverId !== serverId) return true
  if (channel.type !== "thread") return channel.type !== "forum"
  const parent = channels.find((candidate) => candidate.id === channel.parentChannelId)
  return !!parent && parent.type !== "forum"
}

export function isForumSidebarParent(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
) {
  return getCanonicalCommunityChannels(queryClient).some((channel) => (
    channel.id === parentChannelId
    && channel.serverId === serverId
    && channel.type === "forum"
  ))
}

export function hasForumSidebarOwnershipEvidence(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  return getCanonicalCommunityChannels(queryClient).some((channel) => (
    channel.id === childId && channel.serverId === serverId && channel.type === "thread"
  ))
}

export function removeForumSidebarUnreadChild(
  queryClient: QueryClient,
  _serverId: string,
  childChannelId: string,
) {
  patchCanonicalCommunityChannel(queryClient, childChannelId, (row) => ({
    ...row,
    unread: false,
  }))
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
  patchCanonicalCommunityChannel(queryClient, childId, (row) => (
    row.parentChannelId === parentChannelId ? { ...row, lastMessageAt: activityAt } : row
  ))
}

export function patchForumSidebarTitleExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  title: string,
) {
  recordInflightDelta(serverId, (delta) => delta.titles.set(childId, title))
  const channel = getCanonicalCommunityChannels(queryClient)
    .find((candidate) => candidate.id === childId && candidate.serverId === serverId)
  if (channel?.parentMessageId) {
    patchCanonicalCommunityMessage(queryClient, channel.parentMessageId, (row) => ({
      ...row,
      content: title,
    }))
  }
}

export function removeForumSidebarThreadExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  recordInflightDelta(serverId, (delta) => delta.removed.add(childId))
  removeCanonicalCommunityChannel(queryClient, childId)
}

export function removeForumSidebarProjectionExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  recordInflightDelta(serverId, (delta) => delta.removed.add(childId))
  removeCanonicalCommunityChannelMembership(queryClient, childId, "notify")
  removeForumSidebarUnreadChild(queryClient, serverId, childId)
}

export function restoreForumSidebarThreadInflight(serverId: string, childId: string) {
  recordInflightDelta(serverId, (delta) => delta.removed.delete(childId))
}

export function removeForumSidebarChildrenForParent(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
) {
  for (const child of getCanonicalCommunityChannels(queryClient)) {
    if (
      child.serverId === serverId
      && child.type === "thread"
      && child.parentChannelId === parentChannelId
    ) removeForumSidebarThreadExact(queryClient, serverId, child.id)
  }
}

export async function invalidateForumSidebarBaseExact(
  queryClient: QueryClient,
  serverId: string,
) {
  const pending = inflight.get(serverId)
  if (pending) {
    if (pending.abortTimer !== null) globalThis.clearTimeout(pending.abortTimer)
    pending.controller.abort()
    inflight.delete(serverId)
  }
  const queryKey = communityKeys.forumSidebarThreads(serverId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })
}

async function fetchForumSidebarBaseExact(
  queryClient: QueryClient,
  serverId: string,
) {
  const pending = inflight.get(serverId)
  if (pending) {
    if (pending.abortTimer !== null) globalThis.clearTimeout(pending.abortTimer)
    pending.controller.abort()
    inflight.delete(serverId)
  }
  const queryKey = communityKeys.forumSidebarThreads(serverId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })

  const registry = getCommunityDbRegistry(queryClient)
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  const confirmation = unreadProjection.beginAccessConfirmation()
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const requestEpoch = useCommunityWsStore.getState().accessEpoch
  let normalized: NormalizedForumSidebarEnvelope | undefined
  await queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      normalized = await fetchForumSidebar(serverId, null, signal)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      publishNormalizedForumSidebar(
        queryClient,
        serverId,
        normalized,
        null,
        signal,
        token,
      )
      unreadProjection.confirmAccessScopes(
        normalized.base.threads.map((thread) => ({
          kind: "channel" as const,
          channelId: thread.id,
        })),
        confirmation,
      )
      return {
        ...normalized.base,
        threads: registry ? [] : normalized.base.threads,
        verifiedEpoch: requestEpoch,
      }
    },
  })
  if (!normalized) throw new Error("Forum sidebar base fetch did not settle")
  return normalized
}

/**
 * Reconciles persisted viewer-notify rows after a socket gap. The base
 * response is intentionally bounded (72h / five per parent), so ordinary
 * absence is not negative evidence. A missing local row is removable only
 * when it is inside the fresh server window and either the server returned
 * fewer than five siblings or the row would sort above the server's fifth
 * result. Lower-ranked misses cannot displace the authoritative top five and
 * are retained without an unbounded retainId request fan-out.
 */
export async function reconcileForumSidebarNotifyMemberships(
  queryClient: QueryClient,
  serverId: string,
) {
  const channels = getCanonicalCommunityChannels(queryClient)
  const channelById = new Map(channels.map((channel) => [channel.id, channel]))
  const notifyIds = new Set(
    getCanonicalCommunityChannelMemberships(queryClient)
      .filter((membership) => membership.relation === "notify")
      .map((membership) => membership.channelId),
  )
  const candidates = channels.filter((channel) => (
    channel.serverId === serverId
    && channel.type === "thread"
    && notifyIds.has(channel.id)
    && !!channel.parentChannelId
    && channelById.get(channel.parentChannelId)?.type === "forum"
  ))

  // One authoritative query-cache fetch both refreshes active observers and
  // supplies the bounded negative proof. Avoid invalidating into a first
  // active refetch and then issuing a second direct request.
  const base = await fetchForumSidebarBaseExact(queryClient, serverId)
  const baseIds = new Set(base.base.threads.map((thread) => thread.id))
  const baseByParent = new Map<string, ForumSidebarThread[]>()
  for (const thread of base.base.threads) {
    baseByParent.set(thread.parentChannelId, [
      ...(baseByParent.get(thread.parentChannelId) ?? []),
      thread,
    ])
  }
  const serverNowMs = Date.parse(base.base.serverNow)
  const removedIds: string[] = []
  for (const channel of candidates) {
    if (baseIds.has(channel.id) || !channel.parentChannelId) continue
    const activityAt = channel.lastMessageAt ?? ""
    const activityMs = Date.parse(activityAt)
    if (
      Number.isFinite(serverNowMs)
      && Number.isFinite(activityMs)
      && activityMs + SIDEBAR_ACTIVITY_WINDOW_MS <= serverNowMs
    ) continue
    const siblings = (baseByParent.get(channel.parentChannelId) ?? [])
      .slice()
      .sort(compareThreads)
    const candidate = {
      id: channel.id,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId ?? "",
      title: channel.name,
      activityAt,
      expiresAt: Number.isFinite(activityMs)
        ? new Date(activityMs + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
        : activityAt,
      unread: channel.unread,
    }
    if (siblings.length >= 5 && compareThreads(candidate, siblings[4]!) > 0) continue
    publishCommunityForumSidebar(queryClient, {
      serverId,
      channels: [],
      openers: [],
      negativeRetain: { id: channel.id, disposition: "genuine-negative" },
      proof: {
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })
    removedIds.push(channel.id)
  }
  return { removedIds }
}

export async function grantForumSidebarChild(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  const confirmation = unreadProjection.beginAccessConfirmation()
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const normalized = await fetchForumSidebar(serverId, childId)
  publishNormalizedForumSidebar(queryClient, serverId, normalized, childId, undefined, token)
  if (
    hasForumSidebarThread(normalized.base, childId)
    || normalized.retainedDisposition === "eligible" && normalized.retained?.id === childId
  ) {
    unreadProjection.confirmAccessScopes(
      [{ kind: "channel", channelId: childId }],
      confirmation,
    )
  }
}

export function reconcileForumSidebarArchiveTag(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  archived: boolean,
) {
  if (archived) {
    removeCanonicalCommunityChannelMembership(queryClient, childId, "notify")
  } else {
    setCanonicalCommunityChannelMembership(queryClient, childId, "notify", true)
  }
  recordInflightDelta(serverId, (delta) => {
    if (archived) delta.removed.add(childId)
    else delta.removed.delete(childId)
  })
  return invalidateForumSidebarBaseExact(queryClient, serverId)
}

export function useForumSidebarThreads(
  serverId: string,
  retainId: string | null,
  enabled = true,
) {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const query = useQuery<ForumSidebarQueryData>({
    queryKey: communityKeys.forumSidebarThreads(serverId),
    enabled: !!serverId && enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const confirmation = unreadProjection.beginAccessConfirmation()
      const requestEpoch = useCommunityWsStore.getState().accessEpoch
      const normalized = await fetchForumSidebar(serverId, retainId, signal)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      if (registry) {
        publishNormalizedForumSidebar(
          queryClient,
          serverId,
          normalized,
          retainId,
          signal,
          token,
        )
      }
      unreadProjection.confirmAccessScopes(
        [
          ...normalized.base.threads,
          ...(normalized.retainedDisposition === "eligible" && normalized.retained
            ? [normalized.retained]
            : []),
        ].map((thread) => ({ kind: "channel" as const, channelId: thread.id })),
        confirmation,
      )
      return {
        ...normalized.base,
        threads: registry ? [] : normalized.base.threads,
        verifiedEpoch: requestEpoch,
      }
    },
  })
  const previousRetainId = useRef(retainId)
  useEffect(() => {
    if (previousRetainId.current === retainId) return
    previousRetainId.current = retainId
    void invalidateForumSidebarBaseExact(queryClient, serverId)
  }, [queryClient, retainId, serverId])

  const [clockNowMs, setClockNowMs] = useState<number | null>(null)
  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setClockNowMs(Date.now()), 0)
    return () => globalThis.clearTimeout(timeout)
  }, [])
  const serverNowMs = clockNowMs === null
    ? null
    : clockNowMs + (query.data?.serverClockOffsetMs ?? 0)
  const canonical = useForumSidebarProjection(serverId, retainId, serverNowMs)
  const providerless = useMemo(
    () => clockNowMs === null
      ? { threads: [], parentUnread: {} }
      : deriveForumSidebarProjection(query.data, null, undefined, clockNowMs),
    [clockNowMs, query.data],
  )
  const projection = registry
    ? canonical ?? { threads: [], parentUnread: {} }
    : providerless

  useEffect(() => {
    if (serverNowMs === null) return
    const nextExpiry = projection.threads
      .filter((thread) => thread.id !== retainId)
      .map((thread) => Date.parse(thread.expiresAt))
      .filter((expiry) => Number.isFinite(expiry) && expiry > serverNowMs)
      .sort((left, right) => left - right)[0]
    if (nextExpiry === undefined) return
    const timeout = globalThis.setTimeout(
      () => setClockNowMs(Date.now()),
      Math.max(0, nextExpiry - serverNowMs) + 25,
    )
    return () => globalThis.clearTimeout(timeout)
  }, [projection.threads, retainId, serverNowMs])

  return {
    ...query,
    threads: projection.threads,
    parentUnread: projection.parentUnread,
    projectionReady: query.isError || (
      clockNowMs !== null
      && (registry ? canonical !== undefined : query.data !== undefined)
    ),
    verifiedEpoch: accessEpoch,
  }
}
