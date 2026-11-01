"use client"

import { useEffect, useMemo, useRef } from "react"
import { useSelector } from "@tanstack/react-store"
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { channelRefAccessQualification, parseChannelRefDestination, type ChannelRefTarget, type ChannelRefAccessState } from "@/lib/community/channel-ref"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotOwnerCurrent } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityRuntime } from "@/stores/community/runtime"

export type ChannelRefTargetState = "loading" | "ready" | "missing" | "forbidden" | "error"
type RefResource = { target: ChannelRefTarget; token: ReturnType<typeof captureCommunityLiveSnapshotToken>; access: string }

function assertReferenceResource(client: QueryClient, state: ChannelRefAccessState, resource: RefResource) {
  assertCommunityLiveSnapshotOwnerCurrent(client, resource.token, undefined)
  if (resource.access !== channelRefAccessQualification(state, resource.target)) throw new DOMException("Stale reference access", "AbortError")
}

export function useChannelRefTarget(ref: string) {
  const client = useQueryClient()
  const runtime = useCommunityRuntime()
  const destination = useMemo(() => parseChannelRefDestination(ref), [ref])
  const lifetime = useSelector(runtime.lifecycle, state => state.active ? state.generation : -1)
  const accountEpoch = useSelector(runtime.ws, state => state.profileAccountEpoch)
  const qualification = useMemo(() => ({ accountEpoch, accessEpoch: 0, lifetime, scopes: [] }), [accountEpoch, lifetime])
  const queryKey = useMemo(() => communityKeys.channelRefTarget(destination?.ref ?? "", qualification), [destination?.ref, qualification])
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(client), snapshot = runtime.ws.get()
      const known = client.getQueryData<RefResource>(queryKey)?.target
      const access = channelRefAccessQualification(snapshot, known)
      const assert = () => {
        assertCommunityLiveSnapshotOwnerCurrent(client, token, signal)
        if (access !== channelRefAccessQualification(runtime.ws.get(), known)) throw new DOMException("Stale reference request", "AbortError")
      }
      const data = await apiFetchCommunity<{ target: ChannelRefTarget }>(
        `/api/community/channel-ref?${new URLSearchParams({ ref: destination!.ref })}`, { signal }, token, assert,
      )
      const resource = { target: data.target, token, access: channelRefAccessQualification(snapshot, data.target) }
      assertReferenceResource(client, runtime.ws.get(), resource)
      return resource
    },
    enabled: !!destination && lifetime >= 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const access = useSelector(runtime.ws, state => channelRefAccessQualification(state, query.data?.target))
  const key = hashKey(queryKey)
  const observed = useRef<{ key: string; access: string } | undefined>(undefined)
  const enabled = !!destination && lifetime >= 0
  useEffect(() => {
    const previous = observed.current
    observed.current = { key, access }
    if (!previous || previous.key !== key || previous.access === access || !enabled) return
    const current = client.getQueryCache().find({ queryKey, exact: true })
    if (!current) return
    const resource = current.state.data as RefResource | undefined
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
  const currentTarget = () => {
    const current = client.getQueryState(queryKey)
    if (!query.data || query.isFetching || lifetime < 0 || current?.status !== "success" || current.fetchStatus !== "idle" || current.data !== query.data) return null
    try {
      assertReferenceResource(client, runtime.ws.get(), query.data)
      const { target } = query.data
      if (runtime.ws.actions.isChannelAccessRevoked(target.channel.id, target.server.id, target.channel.parentChannelId ?? undefined)) return null
      return target
    } catch {
      return null
    }
  }
  const target = currentTarget()
  const revoked = !!query.data && runtime.ws.actions.isChannelAccessRevoked(query.data.target.channel.id, query.data.target.server.id, query.data.target.channel.parentChannelId ?? undefined)
  const state: ChannelRefTargetState = !destination ? "missing" : revoked ? "forbidden" : target ? "ready"
    : query.error instanceof ApiError && query.error.status === 403 ? "forbidden"
      : query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 400) ? "missing"
        : query.isError ? "error" : "loading"
  return { target, state, messageSeq: destination?.messageSeq, currentTarget, retry: () => query.refetch() }
}
