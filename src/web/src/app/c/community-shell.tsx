"use client"

import { useEffect, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  apiFetchIdentity,
  projectIdentityPayload,
} from "@/lib/community/identity-projection"
import { communityKeys } from "@/lib/query-keys"
import { QueryProvider } from "./QueryProvider"
import {
  CurrentUserProvider,
  useCurrentUser,
  useSetCurrentUser,
  type CurrentUser,
} from "@/contexts/community/current-user"
import { useCommunityWs } from "@/hooks/community/use-community-ws"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { PerfTraceBootstrap } from "@/components/perf/perf-trace-bootstrap"
import { CommunityOnboardingGuide } from "@/components/community/onboarding/community-onboarding-guide"
import { CommunityWsReconnectBoundary } from "@/components/community/shell/community-ws-reconnect-overlay"

/**
 * Client wrapper that provides the QueryClient, CurrentUser, and the
 * community WebSocket handler to every community page.
 *
 * The server-side layout drops the initial session user into this shell.
 * `<CurrentUserProvider>` holds identity for the tree; `<CommunityBootstrap>`
 * mounts the single WS handler and hydrates the viewer's aboutMe field once
 * on mount — the old God-context's on-mount side-effects that survived Step 3.
 *
 * Notification-setting hydration is done via `useNotificationSettings()` in
 * consumers, so we don't fire it here.
 */
export function CommunityShell({
  currentUser,
  children,
}: {
  currentUser: CurrentUser
  children: ReactNode
}) {
  return (
    <QueryProvider key={currentUser.id} userId={currentUser.id}>
      <CurrentUserProvider initialUser={currentUser}>
        <CommunityBootstrap>{children}</CommunityBootstrap>
      </CurrentUserProvider>
    </QueryProvider>
  )
}

/**
 * Mounted once beneath the QueryClient + CurrentUser providers. Owns:
 * - The community WebSocket handler (`useCommunityWs`) — the module-scoped
 *   Zustand stores assume a single instance for the whole session, so it lives
 *   here at the tree root.
 * - The `aboutMe` hydration that used to live in the God-context's mount
 *   effect — needed so the "Edit profile" dialog opens with the current value.
 */
function CommunityBootstrap({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const setCurrentUser = useSetCurrentUser()
  const currentAvatarIdentity = useCommunityWsStore(
    (state) => state.avatarIdentities.get(currentUser.id),
  )
  const avatarIdentities = useCommunityWsStore((state) => state.avatarIdentities)

  // Wire the WS handler once for the whole community subtree. `viewerUserId`
  // powers the `me` flag on incoming reactions — passing null would leave that
  // flag stuck at false for the viewer's own reactions.
  useCommunityWs({ viewerUserId: currentUser.id })

  // Hydrate the live public profile. The auth session can retain a stale image
  // after an avatar upload, while this self endpoint reads the canonical user
  // row alongside the community profile fields.
  const currentUserId = currentUser.id
  useEffect(() => {
    apiFetchIdentity<{ id: string; aboutMe: string; avatar: string; avatarVersion: number; discriminator: string; name: string; statusEmoji: string | null; statusText: string }>(
      "/api/community/users/me/profile",
    )
      .then((data) => {
        const avatarVersion = Number.isSafeInteger(data.avatarVersion)
          ? data.avatarVersion
          : 0
        setCurrentUser((u) => ({
          ...u,
          aboutMe: data.aboutMe,
          avatar: avatarVersion >= (u.avatarVersion ?? 0) && data.avatar
            ? data.avatar
            : u.avatar,
          avatarVersion: Math.max(u.avatarVersion ?? 0, avatarVersion),
          discriminator: data.discriminator,
          name: data.name || u.name,
          statusEmoji: data.statusEmoji,
          statusText: data.statusText,
        }))
        // Member/friend-list surfaces read status from the WS store overlay
        // (see e.g. channels/layout.tsx), not from CurrentUser — seed it here
        // too so the viewer's own rows in those lists match on first load.
        useCommunityWsStore.getState().setUserStatus(currentUserId, data.statusEmoji, data.statusText)
      })
      .catch(() => { })
  }, [setCurrentUser, currentUserId])

  useEffect(() => {
    if (!currentAvatarIdentity) return
    setCurrentUser((user) => currentAvatarIdentity.avatarVersion > (user.avatarVersion ?? 0)
      ? {
          ...user,
          avatar: currentAvatarIdentity.avatar,
          avatarVersion: currentAvatarIdentity.avatarVersion,
        }
      : user)
  }, [currentAvatarIdentity, setCurrentUser])

  // HTTP fetches can discover a newer identity without a WS frame (cold
  // persisted cache, reconnect gap, or a delayed tab). Project that shared
  // highest-version overlay across every already-cached surface and the
  // detached message stream, not only the response that discovered it.
  useEffect(() => {
    if (avatarIdentities.size === 0) return
    let conflict = false
    queryClient.setQueriesData(
      { queryKey: communityKeys.all },
      (cached) => projectIdentityPayload(cached, () => { conflict = true }),
    )
    const stream = useMessageStreamStore.getState()
    for (const [userId, identity] of avatarIdentities) {
      stream.projectAvatarIdentity(userId, identity.avatar, identity.avatarVersion)
    }
    if (conflict) {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.all,
        refetchType: "active",
      })
    }
  }, [avatarIdentities, queryClient])

  return (
    <>
      <PerfTraceBootstrap />
      <CommunityWsReconnectBoundary>
        <CommunityOnboardingGuide />
        {children}
      </CommunityWsReconnectBoundary>
    </>
  )
}
