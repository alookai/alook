"use client"

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import { useInboxProjectionTarget } from "./use-inbox-auto-collapse"
import {
  reservedUnreadExclusion,
  selectUnreadPresentation,
} from "./unread-presentation"

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

export const dmsQueryFn = () =>
  apiFetchProfiles<DmsResponse>(
    "/api/community/users/me/dms",
    (data) => data.conversations.map((dm) => communityUserProfilePatch(dm.userId, dm)),
  )

export function useDms(): UseQueryResult<DmsResponse> & { dms: DM[] } {
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
  const query = useQuery({
    queryKey: communityKeys.dms(),
    queryFn: dmsQueryFn,
    // Inbox navigation projects the destination into this canonical cache
    // before routing. Reusing that projection across /c/me layout mounts keeps
    // the transition request-neutral; WS and reconnect invalidations still
    // refetch this active key explicitly.
    staleTime: Infinity,
  })
  const profilesByUserId = useProfilesByUserId()
  useEffect(() => {
    if (!query.data) return
    unreadProjection.absorbFamily(
      "dms",
      query.data.conversations.flatMap((dm) => dm.lastUnreadSeq === undefined ? [] : [{
        channelId: dm.id,
        lastUnreadSeq: dm.lastUnreadSeq,
      }]),
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
    return (query.data?.conversations ?? EMPTY_DMS).map((dm) => {
      const profile = readCommunityProfile(profilesByUserId.get(dm.userId), dm.userId)
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
        name: profile.name,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
        status: profile.presence,
        unread,
      }
    })
  }, [profilesByUserId, query.data?.conversations, unreadExclusion, unreadProjection, unreadVersion])
  return {
    ...query,
    dms,
  }
}
