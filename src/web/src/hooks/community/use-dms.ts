"use client"
import { loadAndSeedProfiles } from "@/lib/community/account-cache-lifecycle"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { communityUserProfilePatch } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import { parseCommunityDmsRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import type { DM } from "@/lib/community/models/people"
import { useMemo } from "react"
import {
  useCanonicalProfilesByUserId,
} from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useDmProjection } from "@/lib/community-db/projections"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"
import { sortDmsByActivity } from "@/lib/community/dm-order"

const EMPTY_DMS: readonly DM[] = Object.freeze([])

const loadDms = (context: QueryFunctionContext, token: ReturnType<typeof captureCommunityLiveSnapshotToken>) => {
  const registry = getCommunityDbRegistry(context.client)
  return loadAndSeedProfiles(
    async origin => {
      const data = await apiFetch<unknown>("/api/community/users/me/dms", { ...origin, signal: context.signal })
      if (!registry?.accountId) throw new DOMException("Missing DM viewer", "AbortError")
      return parseCommunityDmsRead(data, registry.accountId)
    },
    data => data.conversations.map(dm => communityUserProfilePatch(dm.profile.id, dm.profile)),
    registry,
    context.signal,
    token,
  )
}

export const dmsProjectedQueryFn = (
  queryClient: QueryClient,
) => async (context: QueryFunctionContext) => {
  const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
  const data = await loadDms(context, publicationToken)
  assertCommunityLiveSnapshotTokenCurrent(queryClient, publicationToken, context.signal)
  await publishCommunityLiveSnapshot(queryClient, {
    snapshot: { kind: "dms", data },
    proof: { kind: "structural", token: publicationToken, signal: context.signal },
  })
  return { ids: data.conversations.map((dm) => dm.id) }
}

export function useDms(enabled = true, subscribed = enabled): UseQueryResult<{ ids: string[] }> & { dms: DM[] } {
  const dbDms = useDmProjection()
  const queryClient = useQueryClient()
  const queryFn = useMemo(
    () => dmsProjectedQueryFn(queryClient),
    [queryClient],
  )
  const query = useQuery({
    queryKey: communityKeys.dms(),
    queryFn,
    enabled,
    subscribed,
    // Reuse recent projected DMs across layout mounts; WS/reconnect invalidate explicitly.
    staleTime: 30_000,
  })
  const profilesByUserId = useCanonicalProfilesByUserId()
  const dms = useMemo(() => {
    const source = dbDms ?? EMPTY_DMS
    if (source.length === 0) return EMPTY_DMS as DM[]
    return sortDmsByActivity(source.map((dm) => {
      const liveProfile = profilesByUserId.get(dm.userId)
      const profile = readCommunityProfile(liveProfile, dm.userId)
      return {
        ...dm,
        name: liveProfile?.name ?? dm.name,
        discriminator: liveProfile?.discriminator ?? dm.discriminator,
        avatar: liveProfile?.avatar ?? dm.avatar,
        avatarVersion: liveProfile?.avatarVersion ?? dm.avatarVersion,
        status: liveProfile ? profile.presence : "offline",
      }
    }))
  }, [dbDms, profilesByUserId])
  return {
    ...query,
    dms,
  }
}
