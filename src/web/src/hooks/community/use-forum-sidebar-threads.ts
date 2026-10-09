"use client"
import { useAtom,useCreateAtom } from "@tanstack/react-store"
import { useTrustedRestoredForumProjection } from "@/lib/community-db/projections"
import { getCommunityRuntime } from "@/stores/community/runtime"


import { useEffect,useMemo,useRef } from "react"
import { QueryObserver,useQuery,useQueryClient,type QueryClient } from "@tanstack/react-query"
import { type CommunityChannelIdentity, normalizeCommunityChannelIdentity } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
useAttentionScopes,
useForumSidebarProjection,
} from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
captureCommunityLiveSnapshotToken,
assertCommunityLiveSnapshotTokenCurrent,
getCanonicalCommunityChannelMemberships,
getCanonicalCommunityChannels,
getCanonicalCommunityMessages,
patchCanonicalCommunityChannel,
patchCanonicalCommunityMessage,
publishCommunityForumSidebar,
removeCanonicalCommunityChannelMembership,
setCanonicalCommunityChannelMembership,
type CommunityFreshQueryProof,
type CommunityForumSidebarChannel,
type CommunityForumSidebarOpener,
} from "@/lib/community-db/sync"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import { forumSidebarCandidates, viewerNotifyChannelIds, compareForumSidebarThreads as compareThreads,
  FORUM_SIDEBAR_ACTIVITY_WINDOW_MS as SIDEBAR_ACTIVITY_WINDOW_MS, type ForumSidebarThread } from "@/lib/community/forum-sidebar"
export type { ForumSidebarThread } from "@/lib/community/forum-sidebar"

type ForumSidebarRetainedDisposition =
  | "eligible"
  | "opener-archived"
  | "genuine-negative"

export type SidebarThreadEnvelope = {
  channels: Array<CommunityForumSidebarChannel & { expiresAt: string; createdAt?: string }>
  canonicalChannels?: SidebarThreadEnvelope["channels"]
  retainedChannel?: SidebarThreadEnvelope["channels"][number] | null
  retainedDisposition?: ForumSidebarRetainedDisposition | null
  included: { parentMessages: Array<Omit<CommunityForumSidebarOpener, "type"> & { type?: string }> }
  serverNow: string
}

export type ForumSidebarQueryData = {
  /** Empty with a DB registry; only the explicit providerless test boundary uses rows. */
  threads: ForumSidebarThread[]
  verifiedEpoch: number
  serverNow: string
  serverClockOffsetMs: number
}

export type ChildChannelMeta = Omit<CommunityChannelIdentity, "serverId" | "name" | "parentChannelId" | "parentMessageId" | "createdAt" | "lastMessageAt"> & { [Field in "serverId" | "name" | "parentChannelId" | "parentMessageId"]: NonNullable<CommunityChannelIdentity[Field]> } & {
  activityAt: string
  verifiedEpoch: number
}

export type NormalizedForumSidebarEnvelope = {
  base: ForumSidebarQueryData
  retained: ForumSidebarThread | null
  retainedDisposition: ForumSidebarRetainedDisposition | null
  channels: CommunityForumSidebarChannel[]
  openers: CommunityForumSidebarOpener[]
}

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

function sidebarChannelResource(
  channel: SidebarThreadEnvelope["channels"][number],
): CommunityForumSidebarChannel | null {
  if (!channel.serverId || !channel.type || !channel.parentChannelId || !channel.parentMessageId) {
    return null
  }
  return {
    ...normalizeCommunityChannelIdentity({ ...channel, archived: channel.archived ?? false, creatorId: channel.creatorId ?? null, lastMessageAt: channel.activityAt }),
    serverId: channel.serverId,
    name: channel.name,
    parentChannelId: channel.parentChannelId,
    parentMessageId: channel.parentMessageId,
    activityAt: channel.activityAt,
    unread: channel.unread,
    participating: true,
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
  const channels = [...new Map([
    ...canonicalChannels,
    ...(retainedDisposition === "eligible" && retainedChannel ? [retainedChannel] : []),
  ].map((channel) => [channel.id, sidebarChannelResource(channel)])).values()].filter((channel) => channel !== null)
  const openers = envelope.included.parentMessages.map((message) => ({
    ...message, type: message.type === "system" ? "system" as const : "chat" as const,
  }))
  return { base, retained, retainedDisposition, channels, openers }
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

async function fetchForumSidebar(
  queryClient: QueryClient,
  serverId: string,
  retainId: string | null,
  signal: AbortSignal | undefined,
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>,
) {
  const registry = token.registry
  await registry?.ready
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  await Promise.all([
    registry!.collections.channels.preload(),
    registry!.collections.channelMemberships.preload(),
    registry!.collections.messages.preload(),
  ])
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  const envelope = await apiFetch<SidebarThreadEnvelope>(sidebarUrl(serverId, retainId), communityRequestOptions(queryClient, token, signal))
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  return normalizeForumSidebarEnvelope(envelope, retainId)
}

function publishNormalizedForumSidebar(
  queryClient: QueryClient,
  serverId: string,
  normalized: NormalizedForumSidebarEnvelope,
  retainId: string | null,
  signal: AbortSignal | undefined,
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>,
) {
  publishCommunityForumSidebar(queryClient, {
    serverId, channels: normalized.channels, openers: normalized.openers,
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
  const transport = queryClient.getQueryData<ForumSidebarQueryData>(communityKeys.forumSidebarThreads(serverId))
  const serverClockOffsetMs = transport?.serverClockOffsetMs ?? 0
  const threads = forumSidebarCandidates(getCanonicalCommunityChannels(queryClient),
    getCanonicalCommunityChannelMemberships(queryClient), getCanonicalCommunityMessages(queryClient),
    getCommunityDbRegistry(queryClient)?.accountId ?? null, serverId)
  return { threads, verifiedEpoch: getCommunityRuntime(queryClient).ws.get().accessEpoch,
    serverNow: transport?.serverNow ?? new Date().toISOString(), serverClockOffsetMs } satisfies ForumSidebarQueryData
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
  const channel = getCanonicalCommunityChannels(queryClient)
    .find((candidate) => candidate.id === childId && candidate.serverId === serverId)
  if (channel?.parentMessageId) {
    patchCanonicalCommunityMessage(queryClient, channel.parentMessageId, (row) => ({
      ...row,
      content: title,
    }))
  }
}

export function removeForumSidebarProjectionExact(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
) {
  removeCanonicalCommunityChannelMembership(queryClient, childId, "notify")
  removeForumSidebarUnreadChild(queryClient, serverId, childId)
}

export async function invalidateForumSidebarBaseExact(
  queryClient: QueryClient,
  serverId: string,
) {
  const queryKey = communityKeys.forumSidebarThreads(serverId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })
}

async function fetchForumSidebarBaseExact(
  queryClient: QueryClient,
  serverId: string,
) {
  const queryKey = communityKeys.forumSidebarThreads(serverId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })

  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  const confirmation = unreadProjection.beginAccessConfirmation()
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const requestEpoch = getCommunityRuntime(queryClient).ws.get().accessEpoch
  let normalized: NormalizedForumSidebarEnvelope | undefined
  let proof: CommunityFreshQueryProof | undefined
  await queryClient.query({
    queryKey,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      normalized = await fetchForumSidebar(queryClient, serverId, null, signal, token)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      proof = { token, signal }
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
        threads: [],
        verifiedEpoch: requestEpoch,
      }
    },
    select: undefined,
  })
  if (!normalized || !proof) throw new Error("Forum sidebar base fetch did not settle")
  return { normalized, proof }
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
  // One authoritative query-cache fetch both refreshes active observers and
  // supplies the bounded negative proof. Avoid invalidating into a first
  // active refetch and then issuing a second direct request.
  const { normalized, proof } = await fetchForumSidebarBaseExact(queryClient, serverId)
  return reconcileForumSidebarNotifyMembershipsFromBase(
    queryClient,
    serverId,
    normalized.base,
    proof,
  )
}

function reconcileForumSidebarNotifyMembershipsFromBase(
  queryClient: QueryClient,
  serverId: string,
  base: ForumSidebarQueryData,
  proof: CommunityFreshQueryProof,
  protectedRetainId: string | null = null,
) {
  const channels = getCanonicalCommunityChannels(queryClient)
  const channelById = new Map(channels.map((channel) => [channel.id, channel]))
  const notifyIds = viewerNotifyChannelIds(getCanonicalCommunityChannelMemberships(queryClient),
    getCommunityDbRegistry(queryClient)?.accountId ?? null)
  const candidates = channels.filter((channel) => (
    channel.serverId === serverId
    && channel.type === "thread"
    && notifyIds.has(channel.id)
    && !!channel.parentChannelId
    && channelById.get(channel.parentChannelId)?.type === "forum"
  ))

  const baseIds = new Set(base.threads.map((thread) => thread.id))
  const baseByParent = new Map<string, ForumSidebarThread[]>()
  for (const thread of base.threads) {
    baseByParent.set(thread.parentChannelId, [
      ...(baseByParent.get(thread.parentChannelId) ?? []),
      thread,
    ])
  }
  const serverNowMs = Date.parse(base.serverNow)
  const removedIds: string[] = []
  for (const channel of candidates) {
    if (
      channel.id === protectedRetainId
      || baseIds.has(channel.id)
      || !channel.parentChannelId
    ) continue
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
      proof,
    })
    removedIds.push(channel.id)
  }
  return { removedIds }
}

export async function grantForumSidebarChild(queryClient: QueryClient, serverId: string, childId: string, assertActive?: (() => void) & { signal: AbortSignal }) {
  assertActive?.()
  const options = {
    queryKey: communityKeys.forumSidebarRetained(serverId, childId),
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const unreadProjection = getActiveAccountUnreadProjection(queryClient)
      const confirmation = unreadProjection.beginAccessConfirmation()
      const normalized = await fetchForumSidebar(queryClient, serverId, childId, signal, token)
      publishNormalizedForumSidebar(queryClient, serverId, normalized, childId, signal, token)
      if (hasForumSidebarThread(normalized.base, childId)
        || normalized.retainedDisposition === "eligible" && normalized.retained?.id === childId) {
        unreadProjection.confirmAccessScopes([{ kind: "channel", channelId: childId }], confirmation)
      }
      return { id: childId, disposition: normalized.retainedDisposition, verifiedEpoch: token.accessEpoch }
    },
  }
  const observer = new QueryObserver(queryClient, { ...options, enabled: false })
  const release = observer.subscribe(() => undefined)
  assertActive?.signal.addEventListener("abort", release, { once: true })
  try { const value = await queryClient.query({ ...options, select: undefined }); assertActive?.(); return value } finally { assertActive?.signal.removeEventListener("abort", release); release() }
}

export async function reconcileForumSidebarArchiveTag(
  queryClient: QueryClient,
  serverId: string,
  childId: string,
  archived: boolean,
) {
  const cancellation = queryClient.cancelQueries({ queryKey: communityKeys.forumSidebarRetained(serverId, childId), exact: true })
  if (archived) {
    removeCanonicalCommunityChannelMembership(queryClient, childId, "notify")
  } else {
    setCanonicalCommunityChannelMembership(queryClient, childId, "notify", true)
  }
  await cancellation
  return invalidateForumSidebarBaseExact(queryClient, serverId)
}

export function useForumSidebarThreads(
  serverId: string,
  retainId: string | null,
  enabled = true,
) {
  const restoredForumProjection = useTrustedRestoredForumProjection()
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const query = useQuery<ForumSidebarQueryData>({
    queryKey: communityKeys.forumSidebarThreads(serverId),
    enabled: !!serverId && enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const confirmation = unreadProjection.beginAccessConfirmation()
      const requestEpoch = getCommunityRuntime(queryClient).ws.get().accessEpoch
      const normalized = await fetchForumSidebar(queryClient, serverId, retainId, signal, token)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      publishNormalizedForumSidebar(
          queryClient,
          serverId,
          normalized,
          retainId,
          signal,
          token,
        )
        reconcileForumSidebarNotifyMembershipsFromBase(
          queryClient,
          serverId,
          normalized.base,
          { token, signal },
          normalized.retainedDisposition === "eligible"
            ? normalized.retained?.id ?? null
            : null,
        )
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
        threads: [],
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

  const [clockNowMs, setClockNowMs] = useAtom(useCreateAtom<number | null>(null))
  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setClockNowMs(Date.now()), 0)
    return () => globalThis.clearTimeout(timeout)
  }, [setClockNowMs])
  const serverNowMs = clockNowMs === null
    ? null
    : clockNowMs + (query.data?.serverClockOffsetMs ?? 0)
  const canonical = useForumSidebarProjection(serverId, retainId, serverNowMs)
  const attentionScopes = useAttentionScopes()
  const projection = useMemo(() => {
    const structuralProjection = canonical ?? { threads: [], parentUnread: {} }
    const relevant = attentionScopes.filter((scope) => scope.serverId === serverId)
    const unreadByScope = new Map(relevant.map((scope) => [
      scope.scopeId,
      scope.ordinaryUnread || scope.attentionCount > 0,
    ]))
    const parentUnread: Record<string, boolean> = {}
    for (const scope of relevant) {
      if (scope.parentChannelId && unreadByScope.get(scope.scopeId)) {
        parentUnread[scope.parentChannelId] = true
      } else if (!scope.parentChannelId) {
        parentUnread[scope.channelId] = unreadByScope.get(scope.scopeId) ?? false
      }
    }
    return {
      threads: structuralProjection.threads.map((thread) => ({
        ...thread,
        unread: unreadByScope.get(thread.id) ?? false,
      })),
      parentUnread,
    }
  }, [attentionScopes, serverId, canonical])

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
  }, [projection.threads, retainId, serverNowMs, setClockNowMs])
  return {
    ...query,
    threads: projection.threads,
    parentUnread: projection.parentUnread,
    projectionReady: query.isError || (
      clockNowMs !== null
      && (query.data !== undefined || restoredForumProjection || (canonical?.threads.length ?? 0) > 0)
    ),
    verifiedEpoch: accessEpoch,
  }
}
