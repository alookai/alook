"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { usePathname, useRouter, useParams } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ShellFrame } from "@/components/community/shell-frame"
import { DmSidebar } from "@/components/community/dm-sidebar"
import type { MobileZone } from "@/components/community/_types"
import { useCommunityStore, useCurrentChannelId } from "@/stores/community"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends, useFriendsPresence } from "@/hooks/community/use-friends"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"
import { resolveRowPresence } from "@/lib/community/presence"

// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export default function MeLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const bp = useBreakpoint()
  const pathname = usePathname()
  const params = useParams<{ dmId?: string }>()
  const { dms: rawDms, isLoading: dmsLoading } = useDms()
  const onlineUserIds = useOnlineUserIds()
  const dms = useMemo(
    () =>
      rawDms.map((d) => ({
        ...d,
        status: resolveRowPresence(d, onlineUserIds),
      })),
    [rawDms, onlineUserIds],
  )
  const { blocked } = useFriends()
  const currentChannelId = useCurrentChannelId()
  const queryClient = useQueryClient()

  // Clear the active server when entering the DM home. `currentServerId ===
  // null` is the canonical "no server focused" state — no need for a "@me"
  // sentinel string.
  useEffect(() => {
    useCommunityStore.getState().setCurrentServerId(null)
  }, [])

  // Seed the presence set for the friends/DM subtree — mirrors
  // `channels/layout.tsx`'s `usePresence(serverId)` → `hydratePresence(...)`
  // seed for server members. Without this, a friend who shares no server
  // with you never shows online until a live WS event happens to arrive
  // while you're on this page. `hydratePresence` is a one-shot replacement
  // that no-ops on an identical list, so a re-render with the same online
  // set doesn't cause an extra store write.
  const { online: onlineFriendIds } = useFriendsPresence()
  useEffect(() => {
    useCommunityWsStore.getState().hydratePresence(onlineFriendIds)
  }, [onlineFriendIds])

  const hasDm = !!params.dmId
  const machinesActive = pathname === "/c/me/machines"
  const botsActive = pathname === "/c/me/bots"
  const friendsActive = !hasDm && !machinesActive && !botsActive

  const [mobileZone, setMobileZone] = useState<MobileZone>(() => (hasDm ? "messages" : "nav"))

  // Mirror channel sidebar-click behavior (channels/layout.tsx:226-236): do
  // NOT eagerly mark the DM read on click. That fires a bodyless
  // `PUT /dm/:id/read` which the server aligns to the DM's tail (see
  // api/community/dm/[id]/read/route.ts) — the read-state snapshot then
  // resolves at the tail on mount and `newDividerBefore` computes to
  // `undefined`, so unread DMs open at the bottom with no NEW divider.
  //
  // Instead: client-only optimistic tint on the DM sidebar row so the badge
  // fades on click (matches the pre-fix UX). The IntersectionObserver in
  // `useDmWatermark` is authoritative — it advances the server pointer as the
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
    router.push(`/c/me/${id}`)
    if (bp === "mobile") setMobileZone("messages")
  }, [queryClient, router, bp])

  const onShowFriends = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    router.push("/c/me")
    if (bp === "mobile") setMobileZone("messages")
  }, [router, bp])

  const onShowMachines = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    router.push("/c/me/machines")
    if (bp === "mobile") setMobileZone("messages")
  }, [router, bp])

  const onShowBots = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    router.push("/c/me/bots")
    if (bp === "mobile") setMobileZone("messages")
  }, [router, bp])

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/c/me")
  }, [router])
  const goServer = useCallback(() => { setMobileZone("nav") }, [])

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
      onShowMachines={onShowMachines}
      onShowBots={onShowBots}
      friendsActive={friendsActive}
      machinesActive={machinesActive}
      botsActive={botsActive}
    />
  ), [dms, currentChannelId, dmsLoading, blockedUserIds, enterDm, onShowFriends, onShowMachines, onShowBots, friendsActive, machinesActive, botsActive])

  return (
    <ShellFrame
      view="dm"
      activeServerId={undefined}
      mobileZone={mobileZone}
      setMobileZone={setMobileZone}
      sidebar={sidebar}
      goHome={goHome}
      goServer={goServer}
    >
      {children}
    </ShellFrame>
  )
}
