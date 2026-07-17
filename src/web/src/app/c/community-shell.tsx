"use client"

import { useEffect, type ReactNode } from "react"
import { apiFetch } from "@/lib/api/client"
import { QueryProvider } from "./QueryProvider"
import {
  CurrentUserProvider,
  useCurrentUser,
  useSetCurrentUser,
  type CurrentUser,
} from "@/contexts/community/current-user"
import { useCommunityWs } from "@/hooks/community/use-community-ws"
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
    <QueryProvider userId={currentUser.id}>
      <CurrentUserProvider initialUser={currentUser}>
        <CommunityBootstrap>{children}</CommunityBootstrap>
      </CurrentUserProvider>
    </QueryProvider>
  )
}

/**
 * Mounted once beneath the QueryClient + CurrentUser providers. Owns:
 * - The community WebSocket handler (`useCommunityWs`) — the module-scoped
 *   Zustand stores + pending-reads map assume a single instance for the whole
 *   session, so it lives here at the tree root.
 * - The `aboutMe` hydration that used to live in the God-context's mount
 *   effect — needed so the "Edit profile" dialog opens with the current value.
 */
function CommunityBootstrap({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser()
  const setCurrentUser = useSetCurrentUser()

  // Wire the WS handler once for the whole community subtree. `viewerUserId`
  // powers the `me` flag on incoming reactions — passing null would leave that
  // flag stuck at false for the viewer's own reactions.
  useCommunityWs({ viewerUserId: currentUser.id })

  // Hydrate `aboutMe`/status — the community identity holds email/name/avatar
  // from the session, but the free-text "about me" and custom status live on
  // the community profile row. Fetch it once so the settings dialog and
  // UserBar/ProfileCard open pre-filled instead of blank until the next save
  // or WS event (see plans/profile-card.md).
  const currentUserId = currentUser.id
  useEffect(() => {
    apiFetch<{ aboutMe: string; discriminator: string; statusEmoji: string | null; statusText: string }>(
      "/api/community/users/me/profile",
    )
      .then((data) => {
        setCurrentUser((u) => ({
          ...u,
          aboutMe: data.aboutMe,
          discriminator: data.discriminator,
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

  return <>{children}</>
}
