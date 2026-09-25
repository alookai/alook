"use client"

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
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
  type AccountUnreadSource,
} from "./account-unread-projection"
import { useInboxProjectionTarget } from "./use-inbox-auto-collapse"
import {
  reservedUnreadExclusion,
  selectUnreadPresentation,
} from "./unread-presentation"
import { useDmProjection } from "@/lib/community-db/projections"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

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
) =>
  apiFetchProfiles<DmsResponse>(
    "/api/community/users/me/dms",
    (data) => data.conversations.map((dm) => communityUserProfilePatch(dm.userId, dm)),
    context.signal ? { signal: context.signal } : undefined,
  )

function dmUnreadSources(data: DmsResponse): AccountUnreadSource[] {
  return data.conversations.flatMap((dm) => dm.lastUnreadSeq === undefined ? [] : [{
    channelId: dm.id,
    lastUnreadSeq: dm.lastUnreadSeq,
  }])
}

export const dmsProjectedQueryFn = (
  projection: AccountUnreadProjection,
  queryClient?: QueryClient,
) => async (context: QueryFunctionContext = {} as QueryFunctionContext) => {
  const publicationToken = queryClient
    ? captureCommunityLiveSnapshotToken(queryClient)
    : null
  const token = projection.beginSnapshot("dms", "dms")
  try {
    const data = await dmsQueryFn(context)
    if (queryClient && publicationToken) {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, publicationToken, context.signal)
    }
    projection.absorbSnapshot(token, dmUnreadSources(data))
    if (queryClient && publicationToken) {
      publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "dms", data },
        proof: { kind: "structural", token: publicationToken, signal: context.signal },
      })
    }
    return data
  } catch (error) {
    projection.cancelSnapshot(token)
    throw error
  }
}

export function useDms(): UseQueryResult<DmsResponse> & { dms: DM[] } {
  const dbDms = useDmProjection()
  const queryClient = useQueryClient()
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const unreadVersion = useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const reservationTarget = useInboxProjectionTarget(queryClient)
  const unreadExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "dms"),
    [reservationTarget],
  )
  const queryFn = useMemo(
    () => dmsProjectedQueryFn(unreadProjection, queryClient),
    [queryClient, unreadProjection],
  )
  const query = useQuery({
    queryKey: communityKeys.dms(),
    queryFn,
    // Inbox navigation projects the destination into this canonical cache
    // before routing. Reusing that projection across /c/me layout mounts keeps
    // the transition request-neutral; WS and reconnect invalidations still
    // refetch this active key explicitly.
    staleTime: Infinity,
  })
  const profilesByUserId = useCanonicalProfilesByUserId()
  useEffect(() => {
    if (!query.data) return
    unreadProjection.mergeSources(
      "dms",
      dmUnreadSources(query.data),
      "dms",
    )
    unreadProjection.recordLegacySnapshot(
      query.data,
      query.data.conversations.flatMap((dm) => (
        dm.unread && dm.lastUnreadSeq === undefined
          ? [{ family: "dms" as const, channelId: dm.id }]
          : []
      )),
    )
  }, [query.data, unreadProjection])
  const dms = useMemo(() => {
    void unreadVersion
    return (dbDms ?? query.data?.conversations ?? EMPTY_DMS).map((dm) => {
      const liveProfile = profilesByUserId.get(dm.userId)
      const profile = readCommunityProfile(liveProfile, dm.userId)
      const unread = selectUnreadPresentation({
        accountUnread: unreadProjection.projectUnread(
          "dms",
          dm.id,
          dm.unread === true,
          dm.lastUnreadSeq,
          "dms",
          unreadExclusion,
        ),
      }).effectiveUnread
      return {
        ...dm,
        name: liveProfile?.name ?? dm.name,
        discriminator: liveProfile?.discriminator ?? dm.discriminator,
        avatar: liveProfile?.avatar ?? dm.avatar,
        avatarVersion: liveProfile?.avatarVersion ?? dm.avatarVersion,
        status: liveProfile ? profile.presence : "offline",
        unread,
      }
    })
  }, [dbDms, profilesByUserId, query.data?.conversations, unreadExclusion, unreadProjection, unreadVersion])
  return {
    ...query,
    dms,
  }
}
