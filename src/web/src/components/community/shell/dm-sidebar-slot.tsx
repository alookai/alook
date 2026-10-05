"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useMemo } from "react"
import { useCommunityRouteFrame } from "./community-route-context"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { useCurrentChannelId } from "@/stores/community"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends, useFriendsPresence } from "@/hooks/community/use-friends"
import { useInboxUnreads } from "@/hooks/community/use-inbox"
// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export function DmSidebarSlot() {
  const { frame } = useCommunityRouteFrame()
  if (frame.scope.kind !== "me") return null
  return <MeSidebar />
}

function MeSidebar() {
  const communityRuntime = useCommunityRuntime()
  const { frame } = useCommunityRouteFrame()
  const pathname = frame.pathname
  const {
    dms,
    isLoading: dmsLoading,
  } = useDms()
  const { blocked } = useFriends()
  const friendRequestCount = useInboxUnreads().friendRequests.length
  const currentChannelId = useCurrentChannelId()

  // Seed online friends into the global profile map. The endpoint is a subset
  // of the full WS audience, so it only patches the ids it explicitly returns.
  useFriendsPresence()

  const machinesActive = pathname === "/c/me/machines"
  const botsActive = pathname === "/c/me/bots"
  const friendsActive = pathname === "/c/me/friends"

  // Navigation is intentionally read-neutral. The visible-row observer owns
  // both optimistic clearing and the durable cursor write.
  const enterDm = useCallback((id: string) => {
    communityRuntime.ui.get().uiHandlers.navigatePath?.(`/c/me/${id}`)
  }, [communityRuntime.ui])

  const onShowFriends = useCallback(() => {
    communityRuntime.ui.actions.setCurrentChannelId(null)
    communityRuntime.ui.get().uiHandlers.navigatePath?.("/c/me/friends")
  }, [communityRuntime.ui])

  const onShowMachines = useCallback(() => {
    communityRuntime.ui.actions.setCurrentChannelId(null)
    communityRuntime.ui.get().uiHandlers.navigatePath?.("/c/me/machines")
  }, [communityRuntime.ui])

  const onShowBots = useCallback(() => {
    communityRuntime.ui.actions.setCurrentChannelId(null)
    communityRuntime.ui.get().uiHandlers.navigatePath?.("/c/me/bots")
  }, [communityRuntime.ui])

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

  return sidebar()
}
