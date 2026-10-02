"use client"

import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import {
  useParams,
  usePathname,
  useSelectedLayoutSegments,
} from "next/navigation"
import { ShellFrame } from "@/components/community/shell/shell-frame"
import { DmRoute } from "@/components/community/channels/dm-route"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { useCommunityStore, useCurrentChannelId } from "@/stores/community"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends, useFriendsPresence } from "@/hooks/community/use-friends"
import { useInboxUnreads } from "@/hooks/community/use-inbox"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  isRememberableMeLocation,
  setLastMeLocation,
} from "@/lib/community/last-me-location"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"

// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export default function MeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const currentUser = useCurrentUser()
  const params = useParams<{ dmId?: string }>()
  const selectedSegments = useSelectedLayoutSegments()
  const structuralFrameHref = selectedSegments.length === 0
    ? "/c/me"
    : `/c/me/${selectedSegments.join("/")}`
  const {
    dms,
    isLoading: dmsLoading,
  } = useDms()
  const { blocked } = useFriends()
  const friendRequestCount = useInboxUnreads().friendRequests.length
  const currentChannelId = useCurrentChannelId()

  // Clear the active server when entering the DM home. `currentServerId ===
  // null` is the canonical "no server focused" state — no need for a "@me"
  // sentinel string.
  useEffect(() => {
    useCommunityStore.getState().setCurrentServerId(null)
  }, [])

  // Seed online friends into the global profile map. The endpoint is a subset
  // of the full WS audience, so it only patches the ids it explicitly returns.
  useFriendsPresence()

  const machinesActive = pathname === "/c/me/machines"
  const botsActive = pathname === "/c/me/bots"
  const friendsActive = pathname === "/c/me/friends"
  const staticModuleActive = machinesActive || botsActive || friendsActive

  useEffect(() => {
    if (params.dmId || !staticModuleActive || !isRememberableMeLocation(pathname)) return
    setLastMeLocation(pathname)
    commitLastCommunityRoute(currentUser.id, pathname)
  }, [currentUser.id, params.dmId, pathname, staticModuleActive])

  // Navigation is intentionally read-neutral. The visible-row observer owns
  // both optimistic clearing and the durable cursor write.
  const enterDm = useCallback((id: string) => {
    useCommunityStore.getState().uiHandlers.navigatePath?.(`/c/me/${id}`)
  }, [])

  const onShowFriends = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    useCommunityStore.getState().uiHandlers.navigatePath?.("/c/me/friends")
  }, [])

  const onShowMachines = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    useCommunityStore.getState().uiHandlers.navigatePath?.("/c/me/machines")
  }, [])

  const onShowBots = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    useCommunityStore.getState().uiHandlers.navigatePath?.("/c/me/bots")
  }, [])

  const blockedUserIds = useMemo(
    () => new Set(blocked.map((b) => b.userId ?? b.id)),
    [blocked],
  )

  const sidebar = useCallback(() => (
    <DmSidebar
      dms={dms}
      activeDm={currentChannelId}
      blockedUserIds={blockedUserIds}
      loading={dmsLoading}
      onPickDm={enterDm}
      onShowFriends={onShowFriends}
      friendRequestCount={friendRequestCount}
      onShowMachines={onShowMachines}
      onShowBots={onShowBots}
      friendsActive={friendsActive}
      machinesActive={machinesActive}
      botsActive={botsActive}
    />
  ), [dms, currentChannelId, dmsLoading, blockedUserIds, enterDm, onShowFriends, friendRequestCount, onShowMachines, onShowBots, friendsActive, machinesActive, botsActive])

  return (
    <ShellFrame
      view="dm"
      activeServerId={undefined}
      frameHref={structuralFrameHref}
      sidebar={sidebar}
    >
      {params.dmId
        ? <DmRoute key={`${currentUser.id}/${params.dmId}`} dmId={params.dmId} />
        : children}
    </ShellFrame>
  )
}
