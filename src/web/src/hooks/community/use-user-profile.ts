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
  image: string | null
  aboutMe: string
  bannerColor: string | null
  mutualServers: number
}

export const userProfileQueryFn = (userId: string) => () =>
  apiFetch<UserProfile>(`/api/community/users/${userId}/profile`)
