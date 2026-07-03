"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { usePathname, useRouter, useParams } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ShellFrame } from "@/components/community/shell-frame"
import { DmSidebar } from "@/components/community/dm-sidebar"
import type { MobileZone } from "@/components/community/_types"
import { useCommunityStore, useCurrentChannelId } from "@/stores/community"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends } from "@/hooks/community/use-friends"
import { useMarkDmRead } from "@/hooks/community/mutations"
import { useOnlineUserIds } from "@/stores/community/ws"

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
        status: onlineUserIds.has(d.userId)
          ? ("online" as const)
          : ("offline" as const),
      })),
    [rawDms, onlineUserIds],
  )
  const { blocked } = useFriends()
  const currentChannelId = useCurrentChannelId()
  const markDmRead = useMarkDmRead()

  // Clear the active server when entering the DM home. `currentServerId ===
  // null` is the canonical "no server focused" state — no need for a "@me"
  // sentinel string.
  useEffect(() => {
    useCommunityStore.getState().setCurrentServerId(null)
  }, [])

  const hasDm = !!params.dmId
  const machinesActive = pathname === "/community/me/machines"
  const friendsActive = !hasDm && !machinesActive

  const [mobileZone, setMobileZone] = useState<MobileZone>(() => (hasDm ? "messages" : "nav"))

  const enterDm = useCallback((id: string) => {
    markDmRead.mutate({ dmId: id })
    router.push(`/community/me/${id}`)
    if (bp === "mobile") setMobileZone("messages")
  }, [markDmRead, router, bp])

  const onShowFriends = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    router.push("/community/me")
    if (bp === "mobile") setMobileZone("messages")
  }, [router, bp])

  const onShowMachines = useCallback(() => {
    useCommunityStore.getState().setCurrentChannelId(null)
    router.push("/community/me/machines")
    if (bp === "mobile") setMobileZone("messages")
  }, [router, bp])

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/community/me")
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
      friendsActive={friendsActive}
      machinesActive={machinesActive}
    />
  ), [dms, currentChannelId, dmsLoading, blockedUserIds, enterDm, onShowFriends, onShowMachines, friendsActive, machinesActive])

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
