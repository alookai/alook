"use client"

import { useEffect, useLayoutEffect, type ReactNode } from "react"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
import { QueryProvider } from "./QueryProvider"
import {
  CurrentUserProvider,
  useCurrentUser,
  type CurrentUser,
} from "@/contexts/community/current-user"
import { useCommunityWs } from "@/hooks/community/use-community-ws"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { PerfTraceBootstrap } from "@/components/perf/perf-trace-bootstrap"
import { CommunityOnboardingForm } from "@/components/community/onboarding/community-onboarding-form"
import { CommunityWsReconnectBoundary } from "@/components/community/shell/community-ws-reconnect-overlay"
import { CommunityDaemonUpdateNotice } from "@/components/daemon-update-notice"
import { useCommunityWsStore } from "@/stores/community/ws"

/**
 * Client wrapper that provides the QueryClient, CurrentUser, and the
 * community WebSocket handler to every community page.
 *
 * The server-side layout drops the initial session user into this shell.
 * `<CurrentUserProvider>` holds identity for the tree; `<CommunityBootstrap>`
 * mounts the single WS handler and hydrates the viewer's aboutMe field once
 * on mount — the old God-context's on-mount side-effects that survived Step 3.
 *
 * Notification-setting hydration lives at this root so every unread source
 * request is reconciled against one account policy, including `/c` routes
 * that do not mount a settings consumer.
 */
export function CommunityShell({
  currentUser,
  children,
}: {
  currentUser: CurrentUser
  children: ReactNode
}) {
  return (
    <ProfileAccountBoundary viewerId={currentUser.id}>
      <QueryProvider key={currentUser.id} userId={currentUser.id}>
        <CurrentUserProvider initialUser={currentUser}>
          <CommunityBootstrap>{children}</CommunityBootstrap>
        </CurrentUserProvider>
      </QueryProvider>
    </ProfileAccountBoundary>
  )
}

function ProfileAccountBoundary({
  children,
  viewerId,
}: {
  children: ReactNode
  viewerId: string
}) {
  const activeViewerId = useCommunityWsStore((state) => state.profileViewerId)

  useLayoutEffect(() => {
    if (activeViewerId !== viewerId) {
      useCommunityWsStore.getState().activateProfileAccount(viewerId)
    }
  }, [activeViewerId, viewerId])

  if (activeViewerId !== viewerId) return null
  return children
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
  const currentUser = useCurrentUser()

  useNotificationSettings()
  // Wire the WS handler once for the whole community subtree. `viewerUserId`
  // powers the `me` flag on incoming reactions — passing null would leave that
  // flag stuck at false for the viewer's own reactions.
  useCommunityWs({ viewerUserId: currentUser.id })

  // Hydrate the live public profile. The auth session can retain a stale image
  // after an avatar upload, while this self endpoint reads the canonical user
  // row alongside the community profile fields.
  const currentUserId = currentUser.id
  useEffect(() => {
    apiFetchProfiles<{ id: string; aboutMe: string; avatar: string; avatarVersion: number; discriminator: string; name: string; statusEmoji: string | null; statusText: string }>(
      "/api/community/users/me/profile",
      (profile) => [{
        id: profile.id,
        identityAbout: {
          name: profile.name,
          discriminator: profile.discriminator,
          aboutMe: profile.aboutMe,
        },
        avatar: {
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
        },
        status: {
          statusEmoji: profile.statusEmoji,
          statusText: profile.statusText,
        },
      }],
    )
      .catch(() => { })
  }, [currentUserId])

  return (
    <>
      <PerfTraceBootstrap />
      <CommunityDaemonUpdateNotice userId={currentUser.id} />
      <CommunityWsReconnectBoundary>
        <CommunityOnboardingForm />
        {children}
      </CommunityWsReconnectBoundary>
    </>
  )
}
