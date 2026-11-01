"use client"

import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { parseCommunityUserCardRead, type CommunityUserCardRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import type { QueryFunctionContext } from "@tanstack/react-query"

import { loadAndSeedProfiles, retireCommunityProfile } from "@/lib/community/profile-seed"
import { ApiError } from "@/lib/errors"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

/**
 * Fetches a public user profile card (avatar, name, aboutMe, mutual-server
 * count).
 *
 * The route (`GET /api/community/users/:userId/profile`) is authenticated and
 * returns viewer-relative bot ownership. The community query cache is cleared
 * on logout, so this response remains scoped to the current viewer session.
 */
export type UserProfile = CommunityUserCardRead

export const userProfileQueryFn = (userId: string) => async (context: QueryFunctionContext) => {
  const registry = getCommunityDbRegistry(context.client)
  const token = captureCommunityLiveSnapshotToken(context.client)
  const presence = registry?.runtime.ws.actions.beginPresenceSnapshot()
  try {
    const profile = await loadAndSeedProfiles(
    async origin => parseCommunityUserCardRead(await apiFetch<unknown>(`/api/community/users/${userId}/profile`, { ...origin, signal: context.signal }), userId, registry!.accountId!),
    (profile) => [{
      id: profile.id,
      identityAbout: {
        name: profile.name,
        discriminator: profile.discriminator,
        aboutMe: profile.aboutMe,
        bannerColor: profile.bannerColor,
        kind: profile.kind,
        ownerUserId: profile.kind === "bot" ? profile.ownerProfile.id : null,
      },
      avatar: {
        avatar: profile.image,
        avatarVersion: profile.avatarVersion,
      },
      status: {
        statusEmoji: profile.statusEmoji,
        statusText: profile.statusText,
      },
      card: {
        mutualServers: profile.mutualServers,
        ownerHandle: profile.kind === "bot" ? profile.ownerProfile.handle : null,
        ownedByViewer: profile.kind === "bot" && profile.ownedByViewer,
      },
    }], registry, context.signal, token,
  )
    return { id: profile.id }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && registry && presence) {
      assertCommunityLiveSnapshotTokenCurrent(context.client, token, context.signal)
      if ((registry.runtime.ws.get().presenceRevisionsByUserId.get(userId) ?? 0) <= presence.revision) await retireCommunityProfile(userId, registry, token.profileSnapshot)
    }
    throw error
  }
}

// How long a fetched profile card is considered fresh before a re-click
// triggers a background refetch (`queryClient.query`'s `staleTime`).
// aboutMe/mutual-server-count change rarely enough that re-fetching on
// every click (the pre-cache behavior) was pure waste — see
// shell-frame.tsx's `openProfile`.
export const PROFILE_STALE_TIME_MS = 5 * 60 * 1000
