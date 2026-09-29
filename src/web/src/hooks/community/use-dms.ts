"use client"

import {
  QueryClient,
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import type { DM } from "@/lib/community/models/people"
import { useMemo } from "react"
import {
  useAttentionScopes,
  useCanonicalProfilesByUserId,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useDmProjection } from "@/lib/community-db/projections"
import { sortDmsByActivity } from "@/lib/community/dm-order"
import {
  createDmsResourceQueryFn,
  dmsResourceKey,
  type DmsResource,
} from "@/lib/community-db/dms-resource"

/**
 * Fetches the DM conversation sidebar list.
 *
 * The `Presence` field in each DM is a placeholder "offline" — the actual
 * live badge is layered on later from the WS presence store in the consumer.
 * The WS handler invalidates this key on `community:message.create` events
 * (a DM is a channel now) so previews and unread flags stay live.
 */
export type DmsResponse = { conversations: DM[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_DMS: readonly DM[] = Object.freeze([])

export const dmsQueryFn = (
  context: QueryFunctionContext = {} as QueryFunctionContext,
) => {
  const scopeId = String(context.queryKey?.[2] ?? "anon")
  return createDmsResourceQueryFn(context.client ?? new QueryClient(), scopeId)(context)
}

export function useDms(enabled = true): UseQueryResult<DmsResponse> & { dms: DM[] } {
  const registry = useOptionalCommunityDbRegistry()
  const attentionScopes = useAttentionScopes()
  const dbDms = useDmProjection()
  const queryClient = useQueryClient()
  const scopeId = registry?.scopeId ?? "anon"
  const queryFn = useMemo(() => (
    createDmsResourceQueryFn(queryClient, scopeId)
  ), [queryClient, scopeId])
  const query = useQuery({
    queryKey: dmsResourceKey(scopeId),
    queryFn,
    enabled,
    // Inbox navigation projects the destination into this canonical cache
    // before routing. Reusing that projection across /c/me layout mounts keeps
    // the transition request-neutral; WS and reconnect invalidations still
    // refetch this active key explicitly.
    staleTime: Infinity,
  })
  const profilesByUserId = useCanonicalProfilesByUserId()
  const dms = useMemo(() => {
    const source = registry
      ? dbDms ?? EMPTY_DMS
      : query.data?.conversations ?? EMPTY_DMS
    if (source.length === 0) return EMPTY_DMS as DM[]
    return sortDmsByActivity(source.map((dm) => {
      const liveProfile = profilesByUserId.get(dm.userId)
      const profile = readCommunityProfile(liveProfile, dm.userId)
      const unread = attentionScopes.some((scope) => (
        !scope.serverId && scope.channelId === dm.id && scope.ordinaryUnread
      ))
      return {
        ...dm,
        name: liveProfile?.name ?? dm.name,
        discriminator: liveProfile?.discriminator ?? dm.discriminator,
        avatar: liveProfile?.avatar ?? dm.avatar,
        avatarVersion: liveProfile?.avatarVersion ?? dm.avatarVersion,
        status: liveProfile ? profile.presence : "offline",
        unread,
      }
    }))
  }, [attentionScopes, dbDms, profilesByUserId, query.data?.conversations, registry])
  return {
    ...query,
    dms,
  } as UseQueryResult<DmsResource> & { dms: DM[] }
}
