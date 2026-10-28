"use client"

import { useMemo } from "react"
import { useSelector } from "@tanstack/react-store"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { parseChannelRefDestination, type ChannelRefTarget } from "@/lib/community/channel-ref"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityRuntime } from "@/stores/community/runtime"

export type ChannelRefTargetState = "loading" | "ready" | "missing" | "forbidden" | "error"

export function useChannelRefTarget(ref: string) {
  const client = useQueryClient()
  const runtime = useCommunityRuntime()
  const destination = useMemo(() => parseChannelRefDestination(ref), [ref])
  const lifetime = useSelector(runtime.lifecycle, state => state.active ? state.generation : -1)
  const [accountEpoch, accessEpoch, scopes] = useSelector(runtime.ws, state => [state.profileAccountEpoch, state.accessEpoch, state.channelAccessScopes] as const,
    { compare: (left, right) => left.every((value, index) => value === right[index]) })
  const qualification = useMemo(() => ({ accountEpoch, accessEpoch, lifetime,
    scopes: [...scopes].filter(([, scope]) => scope.generation > 0 || scope.revoked)
      .sort(([left], [right]) => left.localeCompare(right)).map(([id, scope]) => [id, scope.generation, scope.revoked] as const),
  }), [accountEpoch, accessEpoch, lifetime, scopes])
  const queryKey = communityKeys.channelRefTarget(destination?.ref ?? "", qualification)
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(client)
      const data = await apiFetchCommunity<{ target: ChannelRefTarget }>(
        `/api/community/channel-ref?${new URLSearchParams({ ref: destination!.ref })}`, { signal }, token,
      )
      return { target: data.target, token }
    },
    enabled: !!destination && lifetime >= 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const currentTarget = () => {
    const current = client.getQueryState(queryKey)
    if (!query.data || query.isFetching || lifetime < 0 || current?.status !== "success" || current.fetchStatus !== "idle" || current.data !== query.data) return null
    try {
      assertCommunityLiveSnapshotTokenCurrent(client, query.data.token, undefined)
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
