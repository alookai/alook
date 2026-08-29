"use client"

import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useParams,
  usePathname,
  useRouter,
  useSelectedLayoutSegments,
} from "next/navigation"
import { ShellFrame } from "@/components/community/shell/shell-frame"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { DmRouteErrorFrame } from "@/components/community/channels/dm-route-error-frame"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { useCommunityStore, useCurrentChannelId } from "@/stores/community"
import { useDms } from "@/hooks/community/use-dms"
import { useDmRouteVerification } from "@/hooks/community/use-dm-route-verification"
import { useFriends, useFriendsPresence } from "@/hooks/community/use-friends"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  clearLastMeLocation,
  getLastMeLeaf,
  ME_ROOT,
  meLeafFromPathname,
  resolveMeLocationStatus,
  setLastMeLocation,
} from "@/lib/community/last-me-location"

// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export default function MeLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useParams<{ dmId?: string }>()
  const selectedSegments = useSelectedLayoutSegments()
  const structuralFrameHref = selectedSegments.length === 0
    ? "/c/me"
    : `/c/me/${selectedSegments.join("/")}`
  const {
    dms: rawDms,
    isLoading: dmsLoading,
    isPending: dmsPending,
    isFetching: dmsFetching,
  } = useDms()
  const canonicalDmsUnsettled = dmsPending || dmsFetching
  const dmRouteVerification = useDmRouteVerification(params.dmId, rawDms, canonicalDmsUnsettled)
  const profilesByUserId = useCommunityWsStore((state) => state.profilesByUserId)
  const dms = useMemo(
    () =>
      rawDms.map((d) => {
        const profile = readCommunityProfile(profilesByUserId.get(d.userId), d.userId)
        return {
          ...d,
          name: profile.name,
          discriminator: profile.discriminator,
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
          status: profile.presence,
        }
      }),
    [profilesByUserId, rawDms],
  )
  const { blocked } = useFriends()
  const currentChannelId = useCurrentChannelId()
  const queryClient = useQueryClient()
  const cancelPendingNavigation = useCallback(() => {
    useCommunityStore.getState().uiHandlers.cancelPendingNavigation?.()
  }, [])

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

  const meLocationStatus = resolveMeLocationStatus({
    pathname,
    dmId: params.dmId,
    dmRouteStatus: dmRouteVerification.status,
  })

  useEffect(() => {
    if (meLocationStatus === "remember") {
      setLastMeLocation(pathname)
      return
    }
    if (meLocationStatus !== "stale") return
    if (getLastMeLeaf() === meLeafFromPathname(pathname)) clearLastMeLocation()
    cancelPendingNavigation()
    router.replace(ME_ROOT)
  }, [cancelPendingNavigation, meLocationStatus, pathname, router])

  // Mirror channel sidebar-click behavior (channels/layout.tsx:226-236): do
  // NOT eagerly mark the DM read on click. That fires a bodyless
  // `PUT /channels/:id/read` which the server aligns to the DM's tail (see
  // api/community/channels/[id]/read/route.ts) — the read-state snapshot then
  // resolves at the tail on mount and `newDividerBefore` computes to
  // `undefined`, so unread DMs open at the bottom with no NEW divider.
  //
  // Instead: client-only optimistic tint on the DM sidebar row so the badge
  // fades on click (matches the pre-fix UX). The visible-row read observer
  // advances the server pointer as the
  // viewer actually looks at messages. If the user opens then leaves without
  // scrolling to the new messages, the server watermark stays put and the
  // badge re-appears on the next refetch, which is the correct behavior.
  const enterDm = useCallback((id: string) => {
    queryClient.setQueryData(
      communityKeys.dms(),
      (prev: { conversations: { id: string; unread?: boolean }[] } | undefined) =>
        prev
          ? { ...prev, conversations: prev.conversations.map((d) => (d.id === id ? { ...d, unread: false } : d)) }
          : prev,
    )
    useCommunityStore.getState().uiHandlers.navigatePath?.(`/c/me/${id}`)
  }, [queryClient])

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

  const prefetchDm = useCallback((id: string) => router.prefetch(`/c/me/${id}`), [router])
  const prefetchFriends = useCallback(() => router.prefetch("/c/me/friends"), [router])
  const prefetchMachines = useCallback(() => router.prefetch("/c/me/machines"), [router])
  const prefetchBots = useCallback(() => router.prefetch("/c/me/bots"), [router])

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
      onPrefetchDm={prefetchDm}
      onShowFriends={onShowFriends}
      onPrefetchFriends={prefetchFriends}
      onShowMachines={onShowMachines}
      onPrefetchMachines={prefetchMachines}
      onShowBots={onShowBots}
      onPrefetchBots={prefetchBots}
      friendsActive={friendsActive}
      machinesActive={machinesActive}
      botsActive={botsActive}
    />
  ), [dms, currentChannelId, dmsLoading, blockedUserIds, enterDm, prefetchDm, onShowFriends, prefetchFriends, onShowMachines, prefetchMachines, onShowBots, prefetchBots, friendsActive, machinesActive, botsActive])

  return (
    <ShellFrame
      view="dm"
      activeServerId={undefined}
      frameHref={structuralFrameHref}
      sidebar={sidebar}
    >
      {params.dmId && dmRouteVerification.status === "error"
        ? <DmRouteErrorFrame
            onRetry={dmRouteVerification.retry}
            retrying={dmRouteVerification.retrying}
          />
        : params.dmId && meLocationStatus !== "remember"
        ? <CommunityPendingFrame href={pathname} />
        : children}
    </ShellFrame>
  )
}
