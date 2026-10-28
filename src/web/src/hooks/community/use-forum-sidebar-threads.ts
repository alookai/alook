"use client"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { getServerDirectoryWindow } from "@/lib/community/server-directory-window"
import { useHydratedClient } from "@/hooks/use-hydrated-client"
import { useMountedClock } from "@/hooks/use-mounted-clock"
import { getCommunityRuntime } from "@/stores/community/runtime"


import { useEffect,useMemo,useRef } from "react"
import { QueryObserver,useQuery,useQueryClient,type QueryClient } from "@tanstack/react-query"
import { CommunityForumSidebarEnvelopeSchema, type CommunityForumSidebarEnvelope, type CommunityResourceBundle, type CommunityChannelIdentity } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { forumSidebarWindowComplete, readForumSidebarWindowResult, type ForumSidebarWindow } from "@/lib/community/forum-sidebar-window"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
useServerSidebarProjection,
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
setCanonicalCommunityChannelMember,
setCanonicalCommunityChannelMembership,
type CommunityFreshQueryProof,
type CommunityForumSidebarChannel,
type CommunityForumSidebarOpener,
} from "@/lib/community-db/sync"
import { supportsSidebarThreads, forumSidebarCandidates, viewerNotifyChannelIds, compareForumSidebarThreads as compareThreads,
  FORUM_SIDEBAR_ACTIVITY_WINDOW_MS as SIDEBAR_ACTIVITY_WINDOW_MS, type ForumSidebarThread } from "@/lib/community/forum-sidebar"
export type { ForumSidebarThread } from "@/lib/community/forum-sidebar"

type ForumSidebarRetainedDisposition =
  | "eligible"
  | "opener-archived"
  | "genuine-negative"

export type SidebarThreadEnvelope = CommunityForumSidebarEnvelope

export type ForumSidebarQueryData = {
  /** Empty with a DB registry; only the explicit providerless test boundary uses rows. */
  threads: ForumSidebarThread[]
  verifiedEpoch: number
  serverNow: string
  serverClockOffsetMs: number
  window?: ForumSidebarWindow
}

export type ChildChannelMeta = Omit<CommunityChannelIdentity, "serverId" | "name" | "parentChannelId" | "parentMessageId" | "createdAt" | "lastMessageAt"> & { [Field in "serverId" | "name" | "parentChannelId" | "parentMessageId"]: NonNullable<CommunityChannelIdentity[Field]> } & {
  activityAt: string
  verifiedEpoch: number
}

export type NormalizedForumSidebarEnvelope = {
  serverId: string
  resources: CommunityResourceBundle
  base: ForumSidebarQueryData
  retained: ForumSidebarThread | null
  retainedDisposition: ForumSidebarRetainedDisposition | null
  channels: CommunityForumSidebarChannel[]
  openers: CommunityForumSidebarOpener[]
}

export function resolveForumSidebarRouteCandidate(
  channelId: string | null,
  topLevelChannelIds: Iterable<string> | null,
  parentSupportsThreads: boolean | null | undefined,
) {
  if (!channelId || !topLevelChannelIds || !parentSupportsThreads) return null
  return new Set(topLevelChannelIds).has(channelId) ? null : channelId
}

export function hasForumSidebarThread(
  data: ForumSidebarQueryData | undefined,
  threadId: string,
) {
  return !!data?.threads.some((thread) => thread.id === threadId)
}

function projectForumSidebarThreads(data: SidebarThreadEnvelope) {
  const openerById = new Map(data.resources.messages.map((message) => [message.id, message]))
  return data.channels.flatMap((channel): ForumSidebarThread[] => {
    if (!channel.parentChannelId || !channel.parentMessageId) return []
    return [{
      id: channel.id,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      title: openerById.get(channel.parentMessageId)?.content || channel.name || "Post",
      activityAt: channel.activityAt,
      expiresAt: channel.expiresAt,
      unread: false,
    }]
  })
}

export function normalizeForumSidebarEnvelope(
  value: unknown,
  retainId: string | null,
  serverClockOffsetOverride?: number,
): NormalizedForumSidebarEnvelope {
  const envelope = CommunityForumSidebarEnvelopeSchema.parse(value)
  if (retainId ? envelope.retainedDisposition === null || envelope.retainedChannel && envelope.retainedChannel.id !== retainId
    : envelope.retainedDisposition !== null || envelope.retainedChannel !== null) throw new Error("Forum retained result scope mismatch")
  const base: ForumSidebarQueryData = {
    threads: projectForumSidebarThreads({ ...envelope, channels: envelope.canonicalChannels }),
    serverNow: envelope.serverNow, verifiedEpoch: -1,
    serverClockOffsetMs: serverClockOffsetOverride ?? Date.parse(envelope.serverNow) - Date.now(),
  }
  const retained = envelope.retainedChannel ? projectForumSidebarThreads({ ...envelope, channels: [envelope.retainedChannel] })[0] : null
  const selected = [...new Map([...envelope.canonicalChannels, ...(envelope.retainedChannel ? [envelope.retainedChannel] : [])].map(row => [row.id, row])).values()]
  const channels = selected.map(summary => ({
    ...envelope.resources.channels.find(row => row.id === summary.id)!, activityAt: summary.activityAt, unread: summary.unread, participating: true,
  }))
  return { serverId: envelope.serverId, resources: envelope.resources, base, retained, retainedDisposition: envelope.retainedDisposition, channels, openers: envelope.resources.messages }
}

function sidebarUrl(serverId: string, retainId: string | null) {
  const params = new URLSearchParams({
    type: "thread",
    parentType: "forum,text",
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
  if (normalized.serverId !== serverId) throw new Error("Forum sidebar server mismatch")
  publishCommunityForumSidebar(queryClient, {
    serverId, resources: normalized.resources, channels: normalized.channels, openers: normalized.openers,
    negativeRetain: retainId && normalized.retainedDisposition !== "eligible"
      ? {
          id: retainId,
          disposition: normalized.retainedDisposition ?? "genuine-negative",
        }
      : null,
    proof: { token, signal },
  })
  const reconciliation = reconcileForumSidebarNotifyMembershipsFromBase(queryClient, serverId, normalized.base, { token, signal },
    normalized.retainedDisposition === "eligible" ? normalized.retained?.id ?? null : null)
  const reference = ({ id, parentChannelId, parentMessageId }: ForumSidebarThread) => ({ id, parentChannelId, parentMessageId })
  const result = {
    ...normalized.base, threads: [], verifiedEpoch: token.accessEpoch,
    window: {
      version: BUSINESS_SCHEMA_VERSION, accountId: token.viewerId!, serverId,
      parents: [...new Set([...getCanonicalCommunityChannels(queryClient).filter(row => row.serverId === serverId && supportsSidebarThreads(row.type)).map(row => row.id), ...normalized.channels.flatMap(row => row.parentChannelId ? [row.parentChannelId] : [])])],
      base: normalized.base.threads.map(reference),
      retained: retainId ? normalized.retainedDisposition === "eligible" && normalized.retained
        ? { id: retainId, disposition: "eligible" as const, reference: reference(normalized.retained) }
        : { id: retainId, disposition: normalized.retainedDisposition === "opener-archived" ? "opener-archived" as const : "genuine-negative" as const }
        : null,
    },
  }
  const registry = getCommunityDbRegistry(queryClient)!
  if (!readForumSidebarWindowResult(result) || getServerDirectoryWindow(registry, serverId)
    && !forumSidebarWindowComplete(result.window, {
      directory: getServerDirectoryWindow(registry, serverId), servers: [...registry.collections.servers.values()], channels: getCanonicalCommunityChannels(queryClient),
      channelMemberships: getCanonicalCommunityChannelMemberships(queryClient), messages: getCanonicalCommunityMessages(queryClient),
    }, registry.accountId, serverId, retainId, Date.now() + result.serverClockOffsetMs)) throw new Error("Incomplete forum sidebar window")
  return { data: result, reconciliation }
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
  if (channel.type !== "thread") return !supportsSidebarThreads(channel.type)
  const parent = channels.find((candidate) => candidate.id === channel.parentChannelId)
  return !!parent && !supportsSidebarThreads(parent.type)
}

export function isForumSidebarParent(
  queryClient: QueryClient,
  serverId: string,
  parentChannelId: string,
) {
  return getCanonicalCommunityChannels(queryClient).some((channel) => (
    channel.id === parentChannelId
    && channel.serverId === serverId
    && supportsSidebarThreads(channel.type)
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

  const token = captureCommunityLiveSnapshotToken(queryClient)
  let normalized: NormalizedForumSidebarEnvelope | undefined
  let proof: CommunityFreshQueryProof | undefined
  let reconciliation: { removedIds: string[] } | undefined
  await queryClient.query({
    queryKey,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      normalized = await fetchForumSidebar(queryClient, serverId, null, signal, token)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      proof = { token, signal }
      const result = publishNormalizedForumSidebar(
        queryClient,
        serverId,
        normalized,
        null,
        signal,
        token,
      )

      reconciliation = result.reconciliation
      return result.data
    },
    select: undefined,
  })
  if (!normalized || !proof) throw new Error("Forum sidebar base fetch did not settle")
  return { normalized, proof, reconciliation: reconciliation! }
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
  const { reconciliation } = await fetchForumSidebarBaseExact(queryClient, serverId)
  return reconciliation
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
    && supportsSidebarThreads(channelById.get(channel.parentChannelId)?.type)
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
      title: channel.name ?? "",
      activityAt,
      expiresAt: Number.isFinite(activityMs)
        ? new Date(activityMs + SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
        : activityAt,
      unread: false,
    }
    if (siblings.length >= 5 && compareThreads(candidate, siblings[4]!) > 0) continue
    assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
    if (setCanonicalCommunityChannelMember(queryClient, channel.id, proof.token.registry!.accountId!, "notify", false, { proof })) removedIds.push(channel.id)
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
      const normalized = await fetchForumSidebar(queryClient, serverId, childId, signal, token)
      const result = publishNormalizedForumSidebar(queryClient, serverId, normalized, childId, signal, token)
      queryClient.setQueryData(communityKeys.forumSidebarThreads(serverId), result.data)
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
  void queryClient.invalidateQueries({ queryKey: communityKeys.forumSidebarThreads(serverId), exact: true, refetchType: "none" })
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
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const query = useQuery<ForumSidebarQueryData>({
    queryKey: communityKeys.forumSidebarThreads(serverId),
    enabled: !!serverId && enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const normalized = await fetchForumSidebar(queryClient, serverId, retainId, signal, token)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      const result = publishNormalizedForumSidebar(queryClient, serverId, normalized, retainId, signal, token)

      return result.data
    },
  })
  const previousRetainId = useRef(retainId)
  useEffect(() => {
    if (previousRetainId.current === retainId) return
    previousRetainId.current = retainId
    void invalidateForumSidebarBaseExact(queryClient, serverId)
  }, [queryClient, retainId, serverId])

  const hydratedClient = useHydratedClient()
  const [clockNowMs, setClockNowMs] = useMountedClock()
  const serverNowMs = hydratedClient
    ? clockNowMs + (query.data?.serverClockOffsetMs ?? 0)
    : null
  const result = useMemo(() => readForumSidebarWindowResult(query.data), [query.data])
  const sidebar = useServerSidebarProjection(serverId, retainId, serverNowMs, result?.window, query.isError)
  const canonical = sidebar.projection
  useEffect(() => {
    if (!enabled || !(sidebar.needsRead || query.data !== undefined && !result && sidebar.status === "pending") || query.isFetching || query.isError) return
    void invalidateForumSidebarBaseExact(queryClient, serverId)
  }, [enabled, sidebar.needsRead, sidebar.status, result, query.data, query.isFetching, query.isError, queryClient, serverId])
  const projection = canonical ?? { threads: [], parentUnread: {} }

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
    projectionReady: sidebar.status === "ready",
    sidebar,
    verifiedEpoch: accessEpoch,
  }
}
