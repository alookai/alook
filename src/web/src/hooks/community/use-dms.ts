"use client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"


import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
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

const loadDms = (
  context: QueryFunctionContext,
) =>
  apiFetchProfiles<DmsResponse>(
    "/api/community/users/me/dms",
    (data) => data.conversations.map((dm) => communityUserProfilePatch(dm.userId, dm, { legacyPresentation: true })),
    context.signal ? { signal: context.signal } : undefined, getCommunityDbRegistry(context.client),
  )

export const dmsProjectedQueryFn = (
  queryClient: QueryClient,
) => async (context: QueryFunctionContext) => {
  const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
  try {
    const data = await loadDms(context)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, publicationToken, context.signal)
    publishCommunityLiveSnapshot(queryClient, {
      snapshot: { kind: "dms", data },
      proof: { kind: "structural", token: publicationToken, signal: context.signal },
    })
    return { ids: data.conversations.map((dm) => dm.id) }
  } catch (error) {
    throw error
  }
}

export function useDms(enabled = true): UseQueryResult<{ ids: string[] }> & { dms: DM[] } {
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
    subscribed: enabled,
    // Inbox navigation projects the destination into this canonical cache
    // before routing. Reusing that projection across /c/me layout mounts keeps
    // the transition request-neutral; WS and reconnect invalidations still
    // refetch this active key explicitly.
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
