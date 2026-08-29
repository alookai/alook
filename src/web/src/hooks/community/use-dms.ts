"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import { useMemo } from "react"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"

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
  const query = useQuery({
    queryKey: communityKeys.dms(),
    queryFn: dmsQueryFn,
  })
  const profilesByUserId = useProfilesByUserId()
  const dms = useMemo(
    () => (query.data?.conversations ?? EMPTY_DMS).map((dm) => {
      const profile = readCommunityProfile(profilesByUserId.get(dm.userId), dm.userId)
      return {
        ...dm,
        name: profile.name,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
        status: profile.presence,
      }
    }),
    [profilesByUserId, query.data?.conversations],
  )
  return {
    ...query,
    dms,
  }
}
