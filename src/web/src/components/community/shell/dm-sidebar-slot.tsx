"use client"
import { useObservedRegion } from "@/lib/observability/regions"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { dmHref, normalizeCommunityHref, resolveCommunityModulePlan } from "@/lib/community/community-route"
import { Activity, useCallback, useLayoutEffect, useMemo, useState } from "react"
import { useCommunityRouteFrame } from "./community-route-context"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends, useFriendsPresence } from "@/hooks/community/use-friends"
import { useInboxUnreads } from "@/hooks/community/use-inbox"
// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export function DmSidebarSlot({ visible = true, href, routeCommitted = true }: { visible?: boolean; href?: string; routeCommitted?: boolean }) {
  const { frame } = useCommunityRouteFrame()
  const target = normalizeCommunityHref(href ?? frame.href)
  const inMe = target.scope.kind === "me"
  const [visitedMe, setVisitedMe] = useState(inMe)
  useLayoutEffect(() => {
    if (inMe) setVisitedMe(true)
  }, [inMe])
  if (!inMe && !visitedMe) return null
  return <Activity mode={inMe && visible ? "visible" : "hidden"}><MeSidebar pathname={target.pathname} routeCommitted={routeCommitted} /></Activity>
}

function MeSidebar({ pathname, routeCommitted }: { pathname: string; routeCommitted: boolean }) {
  const communityRuntime = useCommunityRuntime()
  const {
    dms,
    isPending: dmsLoading,
    data,
    isError,
    isFetching,
    refetch,
  } = useDms()
  const { blocked } = useFriends()
  const initialError = isError && data === undefined
  useObservedRegion("sidebar", !dmsLoading && !initialError, dms.length)
  const friendRequestCount = useInboxUnreads().friendRequests.length
  const main = resolveCommunityModulePlan(pathname).main
  const currentChannelId = main.kind === "dm" ? main.dmId : null

  // Seed online friends into the global profile map. The endpoint is a subset
  // of the full WS audience, so it only patches the ids it explicitly returns.
  useFriendsPresence(routeCommitted)

  const machinesActive = pathname === "/c/me/machines"
  const privacyActive = pathname === "/c/me/privacy"
  const botsActive = pathname === "/c/me/bots"
  const friendsActive = pathname === "/c/me/friends"

  // Navigation is intentionally read-neutral. The visible-row observer owns
  // both optimistic clearing and the durable cursor write.
  const enterDm = useCallback((id: string) => {
    communityRuntime.ui.get().uiHandlers.navigatePath?.(dmHref(id))
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

  const onShowPrivacy = useCallback(() => {
    communityRuntime.ui.actions.setCurrentChannelId(null)
    communityRuntime.ui.get().uiHandlers.navigatePath?.("/c/me/privacy")
  }, [communityRuntime.ui])

  const blockedUserIds = useMemo(
    () => new Set(blocked.map((b) => b.userId ?? b.id)),
    [blocked],
  )

  const retryDms = useCallback(() => { void refetch({ cancelRefetch: false }) }, [refetch])

  const sidebar = useCallback(() => (
    <DmSidebar
      dms={dms}
      activeDm={currentChannelId}
      blockedUserIds={blockedUserIds}
      loading={dmsLoading}
      loadError={initialError ? { retrying: isFetching, onRetry: retryDms } : undefined}
      onPickDm={enterDm}
      onShowFriends={onShowFriends}
      friendRequestCount={friendRequestCount}
      onShowMachines={onShowMachines}
      onShowBots={onShowBots}
      onShowPrivacy={onShowPrivacy}
      privacyActive={privacyActive}
      friendsActive={friendsActive}
      machinesActive={machinesActive}
      botsActive={botsActive}
    />
  ), [dms, currentChannelId, dmsLoading, initialError, isFetching, retryDms, blockedUserIds, enterDm, onShowFriends, friendRequestCount, onShowMachines, onShowBots, onShowPrivacy, privacyActive, friendsActive, machinesActive, botsActive])

  return sidebar()
}
