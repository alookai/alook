"use client"

import { useCallback, useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
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
import { ApiError } from "@/lib/errors"
import { cacheCommunityShellRoute } from "@/lib/community/replica/shell"
import {
  COMMUNITY_REPLICA_SYNC_EVENT,
  communityReplicaRouteScopes,
  hasActiveCommunityReplicaRoute,
  publishCommunityReplicaSession,
  retireActiveCommunityReplicaScopes,
} from "@/lib/community/replica/session"
import {
  applyCommunityReplicaDelta,
  applyCommunityReplicaIntentOutcomes,
  listCommunityReplicaCoveredChannelIds,
  listCommunityReplicaIntents,
  readCoveredCommunityReplica,
  readCommunityReplicaSnapshot,
  replaceCommunityReplicaBootstrap,
} from "@/lib/community/replica/store"
import {
  clearCommunityReplicaQueryCoverage,
  retireCommunityReplicaQueryScopes,
  seedCommunityReplicaBootstrapQueries,
  seedCommunityReplicaQueries,
} from "@/lib/community/replica/query-seed"
import {
  flushCommunityReplicaReadIntents,
} from "@/hooks/community/read-coordinator"
import { listCommunityReplicaReadWal } from "@/lib/community/replica/read-wal"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"
import { useMessageStreamStore } from "@/stores/community/message-stream"

export { flushCommunityReplicaReadIntents } from "@/hooks/community/read-coordinator"

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
  if (!hasActiveCommunityReplicaRoute(user.id, pathname)) {
    const shell = await cacheCommunityShellRoute(pathname)
    if (!shell.ok) return false
  }
  // The route becomes launchable only after its exact document and immutable
  // assets are durable. The synchronous control WAL is the final commit point,
  // so a browser kill can expose either the previous complete world or this
  // complete world, never projection-without-shell readiness.
  await publishCommunityReplicaSession(user, pathname)
  return true
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
  return frontier
}

async function drainCommunityReplicaDeltas(
  queryClient: QueryClient,
  user: ReplicaSessionUser,
  pathname: string,
  snapshot: CommunityReplicaBootstrapResponse,
  signal: AbortSignal,
) {
  let frontier = selectCommunityReplicaDeltaFrontier(snapshot.frontier)
  if (frontier.length === 0) return "complete" as const
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
      if (response.reason === "permission-changed") {
        const revokedChannelIds = new Set(
          response.scopes.filter((scope) => scope.kind === "channel").map((scope) => scope.id),
        )
        const serverId = communityReplicaRouteScopes(user.id, pathname)
          ?.find((scope) => scope.kind === "server")?.id ?? "revoked"
        const rejected = (await listCommunityReplicaIntents(user.id)).filter((row) => (
          revokedChannelIds.has(row.intent.scope.id)
          && row.state === "canonical-rejected"
        ))
        for (const row of rejected) {
          if (row.outcome?.status !== "rejected") continue
          useMessageStreamStore.getState().dispatch(
            { kind: "channel", id: row.intent.scope.id, serverId },
            { type: "canonicalReject", nonce: row.intentId, reason: row.outcome.reason },
          )
        }
        await retireActiveCommunityReplicaScopes(user.id, response.scopes)
        retireCommunityReplicaQueryScopes(queryClient, response.scopes)
        const currentScopeKeys = new Set(
          (communityReplicaRouteScopes(user.id, pathname) ?? [])
            .map((scope) => `${scope.kind}:${scope.id}`),
        )
        return response.scopes.some((scope) => currentScopeKeys.has(`${scope.kind}:${scope.id}`))
          ? "current-revoked" as const
          : "rebootstrap" as const
      }
      clearCommunityReplicaQueryCoverage(queryClient, response.scopes)
      return "rebootstrap" as const
    }
    frontier = response.frontier
    await seedReplicaScopes(
      queryClient,
      user.id,
      response.frontier.map((entry) => entry.scope),
    )
    if (!response.hasMore) return "complete" as const
  }
}

export async function synchronizeCommunityReplica(
  queryClient: QueryClient,
  user: ReplicaSessionUser,
  pathname: string,
  request: CommunityReplicaBootstrapRequest,
  signal: AbortSignal,
  onCurrentAccessRevoked: () => void,
) {
  const localSnapshot = await readCommunityReplicaSnapshot(user.id)
  if (localSnapshot) {
    const preflight = await drainCommunityReplicaDeltas(
      queryClient,
      user,
      pathname,
      {
        protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
        snapshotId: localSnapshot.meta.snapshotId,
        takenAt: localSnapshot.meta.takenAt,
        frontier: localSnapshot.frontier,
        coverage: localSnapshot.coverage,
        facts: [],
      },
      signal,
    )
    if (preflight === "current-revoked") {
      onCurrentAccessRevoked()
      return
    }
    const routeScopes = communityReplicaRouteScopes(user.id, pathname)
    const routeProjection = routeScopes
      ? await readCoveredCommunityReplica(user.id, routeScopes)
      : null
    if (preflight === "complete" && routeProjection) {
      const hasPendingReads = listCommunityReplicaReadWal(user.id).length > 0
      const hasPendingIntents = (await listCommunityReplicaIntents(user.id))
        .some((row) => row.state === "local-committed")
      await flushCommunityReplicaReadIntents(user.id, signal)
      await flushCommunityReplicaIntents(user.id, signal)
      if (!hasPendingReads && !hasPendingIntents) {
        await seedCurrentRoute(queryClient, user, pathname)
        return
      }
      const advancedSnapshot = await readCommunityReplicaSnapshot(user.id)
      if (!advancedSnapshot) return
      const finalDelta = await drainCommunityReplicaDeltas(
        queryClient,
        user,
        pathname,
        {
          protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
          snapshotId: advancedSnapshot.meta.snapshotId,
          takenAt: advancedSnapshot.meta.takenAt,
          frontier: advancedSnapshot.frontier,
          coverage: advancedSnapshot.coverage,
          facts: [],
        },
        signal,
      )
      if (finalDelta === "current-revoked") {
        onCurrentAccessRevoked()
        return
      }
      if (finalDelta === "complete") {
        await seedCurrentRoute(queryClient, user, pathname)
        return
      }
      // An explicit gap/compaction/schema/permission response is the only
      // compatible-snapshot path that falls through to a new bootstrap.
    }
  }
  await flushCommunityReplicaReadIntents(user.id, signal)
  const coveredChannelIds = await listCommunityReplicaCoveredChannelIds(user.id)
  const retainedRequest = retainCommunityReplicaBootstrapTails(request, coveredChannelIds)
  const currentChannelId = communityReplicaRouteScopes(user.id, pathname)
    ?.find((scope) => scope.kind === "channel")?.id
  const minimalRequest: CommunityReplicaBootstrapRequest = {
    ...request,
    tails: currentChannelId
      ? [request.tails.find((tail) => tail.channelId === currentChannelId) ?? {
          channelId: currentChannelId,
          limit: TAIL_LIMIT,
        }]
      : [],
  }
  const sameTails = (
    left: CommunityReplicaBootstrapRequest,
    right: CommunityReplicaBootstrapRequest,
  ) => left.tails.length === right.tails.length
    && left.tails.every((tail, index) => tail.channelId === right.tails[index]?.channelId)
  const bootstrap = (input: CommunityReplicaBootstrapRequest) => (
    apiFetch<CommunityReplicaBootstrapResponse>(
      "/api/community/replica/bootstrap",
      { method: "POST", body: JSON.stringify(input), signal },
    )
  )
  let snapshot: CommunityReplicaBootstrapResponse
  try {
    snapshot = await bootstrap(retainedRequest)
  } catch (error) {
    if (signal.aborted) throw error
    try {
      // First remove remembered optional tails. If the visible server model is
      // itself stale, fall through to the current route's minimal projection.
      if (!sameTails(retainedRequest, request)) {
        snapshot = await bootstrap(request)
      } else {
        throw error
      }
    } catch (originalError) {
      if (!(originalError instanceof ApiError && originalError.status === 403)) {
        throw originalError
      }
      try {
        if (sameTails(request, minimalRequest)) throw originalError
        snapshot = await bootstrap(minimalRequest)
      } catch (minimalError) {
        if (minimalError instanceof ApiError && minimalError.status === 403) {
          const durable = await readCommunityReplicaSnapshot(user.id)
          const revokedScopes = [
            { kind: "server" as const, id: request.serverId },
            ...(durable?.entities
              .filter((row) => (
                row.scopeKey === `server:${request.serverId}`
                && row.entity.kind === "channel"
              ))
              .map((row) => ({ kind: "channel" as const, id: row.entity.id })) ?? []),
          ]
          await applyCommunityReplicaDelta(user.id, {
            protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
            status: "rebootstrap",
            reason: "permission-changed",
            scopes: revokedScopes,
          })
          retireCommunityReplicaQueryScopes(queryClient, revokedScopes)
          await retireActiveCommunityReplicaScopes(user.id, revokedScopes)
          onCurrentAccessRevoked()
          return
        }
        throw minimalError
      }
    }
  }
  await replaceCommunityReplicaBootstrap(user.id, snapshot)
  // The response has already passed the shared schema and the atomic IDB
  // commit. Publish its render projection synchronously so "covered" becomes
  // true in the same turn as durability, before any background intent flush
  // or shell-cache work can delay a local navigation.
  seedCommunityReplicaBootstrapQueries(queryClient, snapshot)
  await flushCommunityReplicaIntents(user.id, signal)
  const finalDelta = await drainCommunityReplicaDeltas(queryClient, user, pathname, snapshot, signal)
  if (finalDelta === "current-revoked") {
    onCurrentAccessRevoked()
    return
  }
  if (finalDelta === "complete") {
    // Publish only after the complete required scope set has reached a settled
    // frontier. A browser kill must never observe a shell route backed by the
    // bootstrap generation while a final delta can still invalidate it.
    await seedCurrentRoute(queryClient, user, pathname)
  }
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
  const router = useRouter()
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
  const onCurrentAccessRevoked = useCallback(() => {
    commitLastCommunityRoute(user.id, "/c/me/machines")
    router.replace("/c/me/machines")
  }, [router, user.id])

  useEffect(() => {
    if (!request) return
    let active: AbortController | null = null
    const synchronize = () => {
      active?.abort()
      active = new AbortController()
      void synchronizeCommunityReplica(
        queryClient,
        replicaUser,
        pathname,
        request,
        active.signal,
        onCurrentAccessRevoked,
      )
        .catch(() => undefined)
    }
    synchronize()
    const interval = setInterval(synchronize, BACKGROUND_SYNC_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") synchronize()
    }
    window.addEventListener("online", synchronize)
    window.addEventListener(COMMUNITY_REPLICA_SYNC_EVENT, synchronize)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      active?.abort()
      clearInterval(interval)
      window.removeEventListener("online", synchronize)
      window.removeEventListener(COMMUNITY_REPLICA_SYNC_EVENT, synchronize)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [onCurrentAccessRevoked, pathname, queryClient, replicaUser, request])
}
