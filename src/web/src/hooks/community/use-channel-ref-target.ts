"use client"

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useSelector } from "@tanstack/react-store"
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useCommunityOnlineAccount } from "@/hooks/community/community-origin"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import {
  channelRefAccessQualification,
  parseChannelRefDestination,
  type ChannelRefAccessState,
  type ChannelRefResources,
  type ChannelRefTarget,
} from "@/lib/community/channel-ref"
import {
  isChannelRefPointersKey,
  pruneChannelRefPointers,
  readLiveChannelRefTarget,
  resolveChannelRefFromCommunityDb,
} from "@/lib/community/channel-ref-pointers"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotOwnerCurrent,
  publishCommunityChannelRefResolution,
  type ChannelRefQueryResource,
} from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityRuntime } from "@/stores/community/runtime"

export type ChannelRefTargetState = "loading" | "ready" | "missing" | "forbidden" | "error"

function resourceTarget(resource: ChannelRefQueryResource | undefined): ChannelRefTarget | undefined {
  return resource && resource.status === "ready" ? resource.target : undefined
}

function assertReferenceResource(client: QueryClient, state: ChannelRefAccessState, resource: ChannelRefQueryResource) {
  assertCommunityLiveSnapshotOwnerCurrent(client, resource.token, undefined)
  if (resource.access !== channelRefAccessQualification(state, resourceTarget(resource))) throw new DOMException("Stale reference access", "AbortError")
}

function isResourceValid(client: QueryClient, state: ChannelRefAccessState, resource: ChannelRefQueryResource | undefined): boolean {
  if (!resource) return false
  try {
    assertReferenceResource(client, state, resource)
    return true
  } catch {
    return false
  }
}

type ChannelRefDbSnapshot = readonly [
  ReturnType<typeof resolveChannelRefFromCommunityDb>,
  ChannelRefTarget | null,
]

const EMPTY_DB_SNAPSHOT: ChannelRefDbSnapshot = [{ status: "miss" }, null]

function channelRefTargetsEqual(a: ChannelRefTarget | null, b: ChannelRefTarget | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.server.id === b.server.id
    && a.server.name === b.server.name
    && a.channel.id === b.channel.id
    && a.channel.name === b.channel.name
    && (a.channel.parentChannelId ?? null) === (b.channel.parentChannelId ?? null)
  )
}

function channelRefLookupEqual(
  a: ReturnType<typeof resolveChannelRefFromCommunityDb>,
  b: ReturnType<typeof resolveChannelRefFromCommunityDb>,
): boolean {
  if (a === b) return true
  if (a.status !== b.status) return false
  if (a.status === "ready" && b.status === "ready") {
    return channelRefTargetsEqual(a.target, b.target)
  }
  return true
}

function readDbState(
  registry: ReturnType<typeof useOptionalCommunityDbRegistry>,
  destination: ReturnType<typeof parseChannelRefDestination>,
  lifetime: number,
  queryTarget: ChannelRefTarget | undefined,
): ChannelRefDbSnapshot {
  if (!destination || lifetime < 0) return EMPTY_DB_SNAPSHOT
  const lookup = resolveChannelRefFromCommunityDb(registry, destination)
  const live = queryTarget ? readLiveChannelRefTarget(registry, queryTarget) : null
  return [lookup, live]
}

export function useChannelRefTarget(ref: string) {
  const client = useQueryClient()
  const runtime = useCommunityRuntime()
  const registry = useOptionalCommunityDbRegistry()
  const onlineAccount = useCommunityOnlineAccount()
  const destination = useMemo(() => parseChannelRefDestination(ref), [ref])
  const lifetime = useSelector(runtime.lifecycle, state => state.active ? state.generation : -1)
  const accountEpoch = useSelector(runtime.ws, state => state.profileAccountEpoch)
  const qualification = useMemo(() => ({ accountEpoch, accessEpoch: 0, lifetime, scopes: [] }), [accountEpoch, lifetime])
  const queryKey = useMemo(() => communityKeys.channelRefTarget(destination?.ref ?? "", qualification), [destination?.ref, qualification])
  const query = useQuery<ChannelRefQueryResource>({
    queryKey,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(client), snapshot = runtime.ws.get()
      const known = resourceTarget(client.getQueryData<ChannelRefQueryResource>(queryKey))
      const access = channelRefAccessQualification(snapshot, known)
      const assert = () => {
        assertCommunityLiveSnapshotOwnerCurrent(client, token, signal)
        if (access !== channelRefAccessQualification(runtime.ws.get(), known)) throw new DOMException("Stale reference request", "AbortError")
      }
      try {
        const data = await apiFetchCommunity<{ target: ChannelRefTarget; resources?: ChannelRefResources }>(
          `/api/community/channel-ref?${new URLSearchParams({ ref: destination!.ref })}`, { signal }, token, assert,
        )
        const resource: ChannelRefQueryResource = {
          status: "ready",
          target: data.target,
          token,
          access: channelRefAccessQualification(snapshot, data.target),
        }
        assertReferenceResource(client, runtime.ws.get(), resource)
        if (token.registry) {
          await publishCommunityChannelRefResolution(client, destination!.ref, data.target, data.resources, { token, signal })
        }
        return resource
      } catch (error) {
        if (token.registry && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          try {
            assert()
            pruneChannelRefPointers(token.registry, { refs: new Set([destination!.ref]) })
          } catch {}
        }
        throw error
      }
    },
    enabled: !!destination && lifetime >= 0 && onlineAccount,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })

  const queryTarget = resourceTarget(query.data)
  const access = useSelector(runtime.ws, state => channelRefAccessQualification(state, queryTarget))
  const key = hashKey(queryKey)
  const observed = useRef<{ key: string; access: string } | undefined>(undefined)
  const enabled = !!destination && lifetime >= 0 && onlineAccount
  useEffect(() => {
    const previous = observed.current
    observed.current = { key, access }
    if (!previous || previous.key !== key || previous.access === access || !enabled) return
    const current = client.getQueryCache().find({ queryKey, exact: true })
    if (!current) return
    const resource = current.state.data as ChannelRefQueryResource | undefined
    if (resource) {
      try { assertReferenceResource(client, runtime.ws.get(), resource); return } catch {}
    }
    let active = true
    const filters = { queryKey, exact: true, predicate: (candidate: typeof current) => candidate === current }
    void client.cancelQueries(filters).then(() => {
      if (active && runtime.lifecycle.get().active && client.getQueryCache().get(current.queryHash) === current) return client.invalidateQueries(filters)
    }).catch(() => undefined)
    return () => { active = false }
  }, [key, access, enabled, client, queryKey, runtime.ws, runtime.lifecycle])

  const subscribeDb = useCallback((notify: () => void) => {
    const unsubscribeQuery = client.getQueryCache().subscribe((event) => {
      const candidate = event.query.queryKey
      if (
        isChannelRefPointersKey(candidate)
        || (registry && candidate.length === 4 && candidate[0] === "community" && candidate[1] === "db" && candidate[2] === registry.scopeId && (candidate[3] === "servers" || candidate[3] === "channels"))
      ) {
        notify()
      }
    })
    const unsubscribeServers = registry?.collections.servers.subscribeChanges(() => notify())
    const unsubscribeChannels = registry?.collections.channels.subscribeChanges(() => notify())
    return () => {
      unsubscribeQuery()
      unsubscribeServers?.unsubscribe()
      unsubscribeChannels?.unsubscribe()
    }
  }, [client, registry])

  const cachedSnapshotRef = useRef<ChannelRefDbSnapshot>(EMPTY_DB_SNAPSHOT)

  const readDbSnapshot = useCallback((): ChannelRefDbSnapshot => {
    const next = readDbState(registry, destination, lifetime, queryTarget)
    const prev = cachedSnapshotRef.current
    if (channelRefLookupEqual(prev[0], next[0]) && channelRefTargetsEqual(prev[1], next[1])) {
      return prev
    }
    cachedSnapshotRef.current = next
    return next
  }, [destination, lifetime, queryTarget, registry])

  const [dbLookup, liveQueryTarget] = useSyncExternalStore(
    subscribeDb,
    readDbSnapshot,
    () => EMPTY_DB_SNAPSHOT,
  )

  // Strict click navigation gate: only confirmed in-session, settled, non-fetching, non-revoked targets may navigate.
  const currentTarget = () => {
    const current = client.getQueryState<ChannelRefQueryResource>(queryKey)
    if (!query.data || query.data.status !== "ready" || query.isFetching || lifetime < 0
      || current?.status !== "success" || current.fetchStatus !== "idle" || current.data !== query.data) return null
    try {
      assertReferenceResource(client, runtime.ws.get(), query.data)
      const target = readLiveChannelRefTarget(registry, query.data.target)
      if (runtime.ws.actions.isChannelAccessRevoked(target.channel.id, target.server.id, target.channel.parentChannelId ?? undefined)) return null
      return target
    } catch {
      return null
    }
  }

  const verifiedTarget = currentTarget()
  const queryRevoked = !!liveQueryTarget && runtime.ws.actions.isChannelAccessRevoked(
    liveQueryTarget.channel.id,
    liveQueryTarget.server.id,
    liveQueryTarget.channel.parentChannelId ?? undefined,
  )
  const revoked = queryRevoked || dbLookup.status === "revoked"
  const authoritativeForbidden = !query.isFetching && (
    (query.data?.status === "forbidden" && isResourceValid(client, runtime.ws.get(), query.data))
    || (query.error instanceof ApiError && query.error.status === 403)
  )
  const authoritativeMissing = !query.isFetching && (
    (query.data?.status === "missing" && isResourceValid(client, runtime.ws.get(), query.data))
    || (query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 400))
  )

  // SWR display target: renders cached community-db / previous label without reverting to loading during revalidation.
  const swrTarget = !destination || lifetime < 0 || revoked || authoritativeForbidden || authoritativeMissing
    ? null
    : verifiedTarget
      ?? (query.isFetching && liveQueryTarget && isResourceValid(client, runtime.ws.get(), query.data) ? liveQueryTarget : null)
      ?? (dbLookup.status === "ready" ? dbLookup.target : null)

  const state: ChannelRefTargetState = !destination ? "missing"
    : lifetime < 0 ? "loading"
      : revoked || authoritativeForbidden ? "forbidden"
        : authoritativeMissing ? "missing"
          : swrTarget ? "ready"
            : !query.isFetching && query.isError ? "error"
              : "loading"

  return {
    target: state === "ready" ? swrTarget : null,
    state,
    messageSeq: destination?.messageSeq,
    currentTarget,
    retry: () => query.refetch(),
  }
}
