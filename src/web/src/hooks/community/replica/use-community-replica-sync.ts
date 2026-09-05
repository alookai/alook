"use client"

import { useEffect, useMemo } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  COMMUNITY_REPLICA_MAX_BATCHES,
  COMMUNITY_REPLICA_MAX_INTENTS,
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  type CommunityReplicaBootstrapRequest,
  type CommunityReplicaBootstrapResponse,
  type CommunityReplicaDeltaResponse,
  type CommunityReplicaFrontier,
  type CommunityReplicaIntentResponse,
} from "@alook/shared"
import type { ServerDetail } from "@/hooks/community/use-servers"
import type { ReplicaSessionUser } from "@/lib/community/replica/session"
import { apiFetch } from "@/lib/api/client"
import { cacheCommunityShellRoute } from "@/lib/community/replica/shell"
import {
  communityReplicaRouteScopes,
  publishCommunityReplicaSession,
} from "@/lib/community/replica/session"
import {
  applyCommunityReplicaDelta,
  applyCommunityReplicaIntentOutcomes,
  listCommunityReplicaCoveredChannelIds,
  listCommunityReplicaIntents,
  readCoveredCommunityReplica,
  replaceCommunityReplicaBootstrap,
} from "@/lib/community/replica/store"
import {
  clearCommunityReplicaQueryCoverage,
  seedCommunityReplicaBootstrapQueries,
  seedCommunityReplicaQueries,
} from "@/lib/community/replica/query-seed"

const TAIL_LIMIT = 100
const MAX_TAILS = 32
const BACKGROUND_SYNC_INTERVAL_MS = 15_000

export function buildCommunityReplicaBootstrapRequest(
  serverId: string,
  currentChannelId: string | null,
  server: ServerDetail,
): CommunityReplicaBootstrapRequest {
  const ordered = [
    ...(currentChannelId ? [currentChannelId] : []),
    ...server.categories.flatMap((category) => category.channels.map((channel) => channel.id)),
  ]
  return {
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    serverId,
    tails: [...new Set(ordered)].slice(0, MAX_TAILS).map((channelId) => ({
      channelId,
      limit: TAIL_LIMIT,
    })),
  }
}

export function retainCommunityReplicaBootstrapTails(
  request: CommunityReplicaBootstrapRequest,
  coveredChannelIds: string[],
): CommunityReplicaBootstrapRequest {
  const current = request.tails[0]
  const ordered = [
    ...(current ? [current.channelId] : []),
    ...coveredChannelIds,
    ...request.tails.map((tail) => tail.channelId),
  ]
  return {
    ...request,
    tails: [...new Set(ordered)].slice(0, MAX_TAILS).map((channelId) => ({
      channelId,
      limit: TAIL_LIMIT,
    })),
  }
}

async function seedCurrentRoute(
  queryClient: QueryClient,
  user: ReplicaSessionUser,
  pathname: string,
) {
  const scopes = communityReplicaRouteScopes(user.id, pathname)
  if (!scopes) return false
  const projection = await readCoveredCommunityReplica(user.id, scopes)
  if (!projection) return false
  seedCommunityReplicaQueries(queryClient, projection)
  // Publish the coherent local generation before shell staging. Staging can
  // include dozens of hashed assets and may be interrupted by a tab close;
  // making the identity/projection record wait behind it left an otherwise
  // complete Replica unusable after a killed-browser reopen. A missing shell
  // document still fails closed at the service-worker boundary.
  await publishCommunityReplicaSession(user, pathname)
  const shell = await cacheCommunityShellRoute(pathname)
  return shell.ok
}

async function seedReplicaScopes(
  queryClient: QueryClient,
  accountId: string,
  scopes: CommunityReplicaBootstrapResponse["coverage"][number]["scope"][],
  resetCoverage = false,
) {
  const projection = await readCoveredCommunityReplica(accountId, scopes)
  if (!projection) return false
  seedCommunityReplicaQueries(queryClient, projection, { resetCoverage })
  return true
}

export async function flushCommunityReplicaIntents(
  accountId: string,
  signal: AbortSignal,
) {
  for (;;) {
    const rows = await listCommunityReplicaIntents(accountId)
    const pending = rows
      .filter((row) => row.state === "local-committed")
      .slice(0, COMMUNITY_REPLICA_MAX_INTENTS)
    if (pending.length === 0) return

    const response = await apiFetch<CommunityReplicaIntentResponse>(
      "/api/community/replica/intents",
      {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
          intents: pending.map((row) => row.intent),
        }),
        signal,
      },
    )
    const requested = new Set(pending.map((row) => row.intentId))
    if (
      response.outcomes.length !== requested.size
      || response.outcomes.some((outcome) => !requested.has(outcome.intentId))
    ) throw new Error("Replica intent response does not cover the submitted batch")
    await applyCommunityReplicaIntentOutcomes(accountId, response)
  }
}

export function selectCommunityReplicaDeltaFrontier(
  frontier: CommunityReplicaFrontier,
): CommunityReplicaFrontier {
  return frontier.filter((entry) => entry.scope.kind === "channel")
}

async function drainCommunityReplicaDeltas(
  queryClient: QueryClient,
  user: ReplicaSessionUser,
  pathname: string,
  snapshot: CommunityReplicaBootstrapResponse,
  signal: AbortSignal,
) {
  let frontier = selectCommunityReplicaDeltaFrontier(snapshot.frontier)
  if (frontier.length === 0) return true
  for (;;) {
    const response = await apiFetch<CommunityReplicaDeltaResponse>(
      "/api/community/replica/delta",
      {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
          frontier,
          limit: COMMUNITY_REPLICA_MAX_BATCHES,
        }),
        signal,
      },
    )
    await applyCommunityReplicaDelta(user.id, response)
    if (response.status === "rebootstrap") {
      clearCommunityReplicaQueryCoverage(queryClient, response.scopes)
      return false
    }
    frontier = response.frontier
    await seedReplicaScopes(
      queryClient,
      user.id,
      response.frontier.map((entry) => entry.scope),
    )
    await seedCurrentRoute(queryClient, user, pathname)
    if (!response.hasMore) return true
  }
}

async function synchronizeCommunityReplica(
  queryClient: QueryClient,
  user: ReplicaSessionUser,
  pathname: string,
  request: CommunityReplicaBootstrapRequest,
  signal: AbortSignal,
) {
  const coveredChannelIds = await listCommunityReplicaCoveredChannelIds(user.id)
  const retainedRequest = retainCommunityReplicaBootstrapTails(request, coveredChannelIds)
  let snapshot: CommunityReplicaBootstrapResponse
  try {
    snapshot = await apiFetch<CommunityReplicaBootstrapResponse>(
      "/api/community/replica/bootstrap",
      { method: "POST", body: JSON.stringify(retainedRequest), signal },
    )
  } catch (error) {
    const retainedIds = retainedRequest.tails.map((tail) => tail.channelId)
    const requestedIds = request.tails.map((tail) => tail.channelId)
    if (JSON.stringify(retainedIds) === JSON.stringify(requestedIds) || signal.aborted) throw error
    // A remembered optional tail may have been revoked since its last lease.
    // Retry the current server projection without it so stale coverage cannot
    // wedge all future bootstraps or require manual local-data recovery.
    snapshot = await apiFetch<CommunityReplicaBootstrapResponse>(
      "/api/community/replica/bootstrap",
      { method: "POST", body: JSON.stringify(request), signal },
    )
  }
  await replaceCommunityReplicaBootstrap(user.id, snapshot)
  // The response has already passed the shared schema and the atomic IDB
  // commit. Publish its render projection synchronously so "covered" becomes
  // true in the same turn as durability, before any background intent flush
  // or shell-cache work can delay a local navigation.
  seedCommunityReplicaBootstrapQueries(queryClient, snapshot)
  // Establish the synchronous control commit immediately after the atomic
  // snapshot lands; later projection seeding and shell refreshes are allowed
  // to be interrupted by a browser kill without losing launchability.
  await publishCommunityReplicaSession(user, pathname)
  await flushCommunityReplicaIntents(user.id, signal)
  await seedCurrentRoute(queryClient, user, pathname)
  await drainCommunityReplicaDeltas(queryClient, user, pathname, snapshot, signal)
}

export function useCommunityReplicaSync({
  user,
  pathname,
  serverId,
  currentChannelId,
  server,
}: {
  user: Omit<ReplicaSessionUser, "avatarVersion"> & { avatarVersion?: number }
  pathname: string
  serverId: string
  currentChannelId: string | null
  server: ServerDetail | null
}) {
  const queryClient = useQueryClient()
  const replicaUser = useMemo<ReplicaSessionUser>(() => ({
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    avatarVersion: user.avatarVersion ?? 0,
  }), [user.avatar, user.avatarVersion, user.email, user.id, user.name])
  const request = useMemo(
    () => server
      ? buildCommunityReplicaBootstrapRequest(serverId, currentChannelId, server)
      : null,
    [currentChannelId, server, serverId],
  )

  useEffect(() => {
    if (!request) return
    let active: AbortController | null = null
    const synchronize = () => {
      active?.abort()
      active = new AbortController()
      void synchronizeCommunityReplica(queryClient, replicaUser, pathname, request, active.signal)
        .catch(() => undefined)
    }
    synchronize()
    const interval = setInterval(synchronize, BACKGROUND_SYNC_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") synchronize()
    }
    window.addEventListener("online", synchronize)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      active?.abort()
      clearInterval(interval)
      window.removeEventListener("online", synchronize)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [pathname, queryClient, replicaUser, request])
}
