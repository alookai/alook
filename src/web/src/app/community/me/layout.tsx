"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { usePathname, useRouter, useParams } from "next/navigation"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { ShellFrame } from "@/components/community/shell-frame"
import { DmSidebar } from "@/components/community/dm-sidebar"
import type { MobileZone } from "@/components/community/_types"

// DM-side layout. The DM subtree has no server settings, no channel sidebar,
// and no `[serverId]` param — everything is scoped to the current user.
export default function MeLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const bp = useBreakpoint()
  const pathname = usePathname()
  const params = useParams<{ dmId?: string }>()
  const ctx = useCommunity()

  useEffect(() => {
    ctx.setCurrentServerId("@me")
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const hasDm = !!params.dmId
  const machinesActive = pathname === "/community/me/machines"
  const friendsActive = !hasDm && !machinesActive

  const [mobileZone, setMobileZone] = useState<MobileZone>(() => (hasDm ? "messages" : "nav"))

  const enterDm = useCallback((id: string) => {
    ctx.markDmRead(id)
    router.push(`/community/me/${id}`)
    if (bp === "mobile") setMobileZone("messages")
  }, [ctx.markDmRead, router, bp])

  const onShowFriends = useCallback(() => {
    ctx.setCurrentChannelId(null)
    router.push("/community/me")
    if (bp === "mobile") setMobileZone("messages")
  }, [ctx.setCurrentChannelId, router, bp])

  const onShowMachines = useCallback(() => {
    ctx.setCurrentChannelId(null)
    router.push("/community/me/machines")
    if (bp === "mobile") setMobileZone("messages")
  }, [ctx.setCurrentChannelId, router, bp])

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/community/me")
  }, [router])
  const goServer = useCallback(() => { setMobileZone("nav") }, [])

  const blockedUserIds = useMemo(() => new Set(ctx.blocked.map((b) => b.userId ?? b.id)), [ctx.blocked])

  const sidebar = useCallback(() => (
    <DmSidebar
      dms={ctx.dms ?? []}
      activeDm={ctx.currentChannelId}
      blockedUserIds={blockedUserIds}
      loading={ctx.dmsLoading}
      onPickDm={enterDm}
      onShowFriends={onShowFriends}
      onShowMachines={onShowMachines}
      friendsActive={friendsActive}
      machinesActive={machinesActive}
    />
  ), [ctx.dms, ctx.currentChannelId, ctx.dmsLoading, blockedUserIds, enterDm, onShowFriends, onShowMachines, friendsActive, machinesActive])

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
