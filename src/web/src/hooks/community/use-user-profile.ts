"use client"

import { apiFetch } from "@/lib/api/client"

/**
 * Fetches a public user profile card (avatar, name, aboutMe, mutual-server
 * count).
 *
 * The route (`GET /api/community/users/:userId/profile`) already gates on
 * viewer visibility, so we can cache freely under the viewer's session.
 */
export type UserProfile = {
  id: string
  name: string
  discriminator: string
  image: string | null
  aboutMe: string
  bannerColor: string | null
  mutualServers: number
}

export const userProfileQueryFn = (userId: string) => () =>
  apiFetch<UserProfile>(`/api/community/users/${userId}/profile`)

// How long a fetched profile card is considered fresh before a re-click
// triggers a background refetch (`queryClient.fetchQuery`'s `staleTime`).
// aboutMe/mutual-server-count change rarely enough that re-fetching on
// every click (the pre-cache behavior) was pure waste — see
// shell-frame.tsx's `openProfile`.
export const PROFILE_STALE_TIME_MS = 5 * 60 * 1000
