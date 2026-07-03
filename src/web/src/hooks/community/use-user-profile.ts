"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

/**
 * Fetches a public user profile card (avatar, name, aboutMe, mutual-server
 * count). Consumed by the profile popover.
 *
 * The route (`GET /api/community/users/:userId/profile`) already gates on
 * viewer visibility, so we can cache freely under the viewer's session.
 */
export type UserProfile = {
  id: string
  name: string
  image: string | null
  aboutMe: string
  bannerColor: string | null
  mutualServers: number
}

export const userProfileQueryFn = (userId: string) => () =>
  apiFetch<UserProfile>(`/api/community/users/${userId}/profile`)

export function useUserProfile(
  userId: string | null,
): UseQueryResult<UserProfile> & { profile: UserProfile | null } {
  const enabled = !!userId
  const query = useQuery({
    queryKey: enabled ? communityKeys.profile(userId!) : communityKeys.profile("__none__"),
    queryFn: enabled
      ? userProfileQueryFn(userId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    profile: query.data ?? null,
  }
}
