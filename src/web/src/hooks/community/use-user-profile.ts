"use client"

import { apiFetch } from "@/lib/api/client"

/**
 * Fetches a public user profile card (avatar, name, aboutMe, mutual-server
 * count).
 *
 * The route (`GET /api/community/users/:userId/profile`) is authenticated and
 * returns viewer-relative bot ownership. The community query cache is cleared
 * on logout, so this response remains scoped to the current viewer session.
 */
type UserProfileBase = {
  id: string
  name: string
  discriminator: string
  image: string | null
  aboutMe: string
  bannerColor: string | null
  mutualServers: number
  statusEmoji: string | null
  statusText: string | null
}

export type UserProfile = UserProfileBase & (
  | { kind: "human" }
  | {
      kind: "bot"
      ownerProfile: { id: string; handle: string }
      ownedByViewer: boolean
    }
)

export const userProfileQueryFn = (userId: string) => () =>
  apiFetch<UserProfile>(`/api/community/users/${userId}/profile`)

// How long a fetched profile card is considered fresh before a re-click
// triggers a background refetch (`queryClient.fetchQuery`'s `staleTime`).
// aboutMe/mutual-server-count change rarely enough that re-fetching on
// every click (the pre-cache behavior) was pure waste — see
// shell-frame.tsx's `openProfile`.
export const PROFILE_STALE_TIME_MS = 5 * 60 * 1000
